import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  purgeResidentPortalData,
  purgeManagerPortalData,
  purgeVendorPortalData,
  findAuthUserIdByEmail,
  removePortalAccess,
  getStripe,
  isAdminManagedManagerPurchase,
} = vi.hoisted(() => ({
  purgeResidentPortalData: vi.fn(),
  purgeManagerPortalData: vi.fn(),
  purgeVendorPortalData: vi.fn(),
  findAuthUserIdByEmail: vi.fn(),
  removePortalAccess: vi.fn(),
  getStripe: vi.fn(),
  isAdminManagedManagerPurchase: vi.fn(),
}));

vi.mock("@/lib/auth/purge-portal-account-data", () => ({
  purgeResidentPortalData,
  purgeManagerPortalData,
  purgeVendorPortalData,
}));

vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({
  findAuthUserIdByEmail,
}));

vi.mock("@/lib/auth/remove-portal-access", () => ({
  removePortalAccess,
}));

vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/manager-admin-purchase", () => ({ isAdminManagedManagerPurchase }));

import {
  canHardDeleteResident,
  deleteAdminPortalAccount,
  deleteOwnAccount,
  deleteOwnPortalAccount,
  deletePortalAccountCompletely,
  deleteResidentAccount,
} from "@/lib/auth/delete-portal-account";

function mockDb(roleRows: { role: string }[], legacyRole = "resident") {
  const userId = "user-dual";
  findAuthUserIdByEmail.mockResolvedValue(userId);
  return {
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: userId, role: legacyRole, email: "dual@test.com" } }),
            }),
          }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: () => ({
            eq: async () => ({ data: roleRows }),
          }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
    },
    auth: { admin: { deleteUser: vi.fn(async () => ({ error: null })) } },
  };
}

describe("delete-portal-account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removePortalAccess.mockResolvedValue({ ok: true, mode: "revoked_role", remainingRoles: ["manager"] });
  });

  it("reports non-hard-deletable residents that also have manager role", async () => {
    const db = mockDb([{ role: "resident" }, { role: "manager" }]);
    const guard = await canHardDeleteResident(db as never, "dual@test.com");
    expect(guard.ok).toBe(false);
  });

  it("revokes resident role when user also has manager role", async () => {
    const db = mockDb([{ role: "resident" }, { role: "manager" }]);

    const result = await deleteResidentAccount(db as never, {
      email: "dual@test.com",
      purgeData: true,
    });

    expect(result.ok).toBe(true);
    expect(purgeResidentPortalData).toHaveBeenCalled();
    expect(removePortalAccess).toHaveBeenCalledWith(db, "user-dual", "resident");
  });

  it("purges application-only deletes with purged_data_only mode", async () => {
    findAuthUserIdByEmail.mockResolvedValue(null);
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }),
      auth: { admin: { deleteUser: vi.fn() } },
    };

    const result = await deleteResidentAccount(db as never, {
      applicationId: "app-1",
      purgeData: true,
    });

    expect(purgeResidentPortalData).toHaveBeenCalledWith(db, {
      email: "",
      userId: null,
      applicationId: "app-1",
    });
    expect(result).toEqual({ ok: true, mode: "purged_data_only" });
  });

  it("fully deletes portal accounts for admin cleanup", async () => {
    const deleteUser = vi.fn(async () => ({ error: null }));
    const db = {
      from: (table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { email: "manager@test.com" } }),
              }),
            }),
            delete: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
        if (table === "profile_roles") {
          return {
            delete: () => ({
              eq: async () => ({ error: null }),
            }),
          };
        }
        return {
          delete: () => ({
            eq: async () => ({ error: null }),
            ilike: async () => ({ error: null }),
          }),
        };
      },
      auth: { admin: { deleteUser } },
    };

    const result = await deletePortalAccountCompletely(db as never, "user-1");

    expect(purgeManagerPortalData).toHaveBeenCalledWith(db, "user-1");
    expect(purgeResidentPortalData).toHaveBeenCalledWith(db, {
      email: "manager@test.com",
      userId: "user-1",
    });
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({ ok: true, mode: "deleted_auth_user" });
  });

  it("self-delete from resident portal revokes only resident access when manager role remains", async () => {
    findAuthUserIdByEmail.mockResolvedValue("user-dual");
    let roleReads = 0;
    const db = {
      from: (table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: "user-dual",
                    role: roleReads >= 2 ? "resident" : "manager",
                    email: "dual@test.com",
                  },
                }),
              }),
            }),
          };
        }
        if (table === "profile_roles") {
          return {
            select: () => ({
              eq: async () => {
                roleReads += 1;
                if (roleReads === 1) return { data: [{ role: "resident" }, { role: "manager" }] };
                return { data: [{ role: "manager" }] };
              },
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        };
      },
      auth: { admin: { deleteUser: vi.fn() } },
    };
    removePortalAccess.mockResolvedValue({ ok: true, mode: "revoked_role", remainingRoles: ["manager"] });

    const result = await deleteOwnPortalAccount(db as never, "user-dual", "resident");

    expect(result.ok).toBe(true);
    expect(result.signedOut).toBe(false);
    expect(result.redirectTo).toBe("/portal/dashboard");
    expect(purgeResidentPortalData).toHaveBeenCalled();
    expect(removePortalAccess).toHaveBeenCalledWith(db, "user-dual", "resident");
  });

  it("self-delete from manager portal purges manager data and keeps resident role", async () => {
    let roleReads = 0;
    purgeManagerPortalData.mockResolvedValue(undefined);
    removePortalAccess
      .mockResolvedValueOnce({ ok: true, mode: "revoked_role", remainingRoles: ["resident"] })
      .mockResolvedValueOnce({ ok: true, mode: "no_role" });

    const db = {
      from: (table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "user-dual", role: "resident", email: "dual@test.com" },
                }),
              }),
            }),
          };
        }
        if (table === "profile_roles") {
          return {
            select: () => ({
              eq: async () => {
                roleReads += 1;
                if (roleReads === 1) return { data: [{ role: "resident" }, { role: "manager" }] };
                return { data: [{ role: "resident" }] };
              },
            }),
          };
        }
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        };
      },
      auth: { admin: { deleteUser: vi.fn() } },
    };

    const result = await deleteOwnPortalAccount(db as never, "user-dual", "manager");

    expect(result.ok).toBe(true);
    expect(result.signedOut).toBe(false);
    expect(result.redirectTo).toBe("/resident");
    expect(purgeManagerPortalData).toHaveBeenCalledWith(db, "user-dual");
  });

  it("admin delete runs the same full teardown as self-delete", async () => {
    const cancel = vi.fn(async () => ({}));
    getStripe.mockReturnValue({ subscriptions: { cancel } });
    isAdminManagedManagerPurchase.mockReturnValue(false);

    const deleteUser = vi.fn(async () => ({ error: null }));
    const db = {
      from: (table: string) => {
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "mgr@test.com" } }) }) }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === "profile_roles") {
          return { delete: () => ({ eq: async () => ({ error: null }) }) };
        }
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      },
      auth: { admin: { deleteUser } },
    };

    const result = await deleteAdminPortalAccount(db as never, "admin-target");

    expect(purgeManagerPortalData).toHaveBeenCalledWith(db, "admin-target");
    expect(purgeResidentPortalData).toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("admin-target");
    expect(result).toEqual({ ok: true, mode: "deleted_auth_user" });
  });

  it("deletes the login when self-delete leaves no role behind", async () => {
    // The portal role is gone by the time the result is computed, but the helper that
    // removed it did not delete the auth user. Reporting success here would free the
    // portal and strand the login, so the same email could never be registered again.
    removePortalAccess.mockResolvedValue({ ok: true, mode: "revoked_role", remainingRoles: [] });
    const deleteUser = vi.fn(async () => ({ error: null }));
    let profilesRead = 0;
    const db = {
      from: (table: string) => {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  profilesRead += 1;
                  // The role is gone from the second read on: removePortalAccess revoked it.
                  return {
                    data: { id: "left-over", role: profilesRead > 1 ? null : "manager", email: "left@test.com" },
                  };
                },
              }),
            }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === "profile_roles") {
          return {
            select: () => ({ eq: async () => ({ data: [] }) }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      },
      auth: { admin: { deleteUser } },
    };

    const result = await deleteOwnPortalAccount(db as never, "left-over", "manager");

    expect(deleteUser).toHaveBeenCalledWith("left-over");
    expect(result).toEqual({
      ok: true,
      mode: "deleted_auth_user",
      signedOut: true,
      redirectTo: "/auth/sign-in?deleted=1",
    });
  });

  it("self-delete cancels the active Stripe subscription, cleans vendor data, and deletes the auth user", async () => {
    const cancel = vi.fn(async () => ({}));
    getStripe.mockReturnValue({ subscriptions: { cancel } });
    isAdminManagedManagerPurchase.mockReturnValue(false);

    const deleteUser = vi.fn(async () => ({ error: null }));
    const db = {
      from: (table: string) => {
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { stripe_subscription_id: "sub_123", stripe_checkout_session_id: "cs_live_x" },
                }),
              }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "me@test.com" } }) }) }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === "profile_roles") {
          return { delete: () => ({ eq: async () => ({ error: null }) }) };
        }
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      },
      auth: { admin: { deleteUser } },
    };

    const result = await deleteOwnAccount(db as never, "user-self");

    expect(cancel).toHaveBeenCalledWith("sub_123");
    expect(purgeVendorPortalData).toHaveBeenCalledWith(db, { userId: "user-self", email: "me@test.com" });
    expect(purgeManagerPortalData).toHaveBeenCalledWith(db, "user-self");
    expect(deleteUser).toHaveBeenCalledWith("user-self");
    expect(result).toEqual({ ok: true, mode: "deleted_auth_user" });
  });

  it("self-delete skips Stripe cancel for admin-comped tiers (no real subscription)", async () => {
    const cancel = vi.fn(async () => ({}));
    getStripe.mockReturnValue({ subscriptions: { cancel } });
    isAdminManagedManagerPurchase.mockReturnValue(true);

    const deleteUser = vi.fn(async () => ({ error: null }));
    const db = {
      from: (table: string) => {
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { stripe_subscription_id: "sub_admin", stripe_checkout_session_id: "admin_comp_x" } }),
              }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "me@test.com" } }) }) }),
            delete: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === "profile_roles") {
          return { delete: () => ({ eq: async () => ({ error: null }) }) };
        }
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      },
      auth: { admin: { deleteUser } },
    };

    const result = await deleteOwnAccount(db as never, "user-comp");

    expect(cancel).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("user-comp");
    expect(result).toEqual({ ok: true, mode: "deleted_auth_user" });
  });
});
