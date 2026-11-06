import { describe, expect, it, vi } from "vitest";
import { heldPortalRoles } from "@/lib/auth/held-portal-roles";
import { removePortalAccess } from "@/lib/auth/remove-portal-access";

/**
 * Deleting a portal account has to leave the email genuinely free to sign up again. Two
 * bookkeeping holes made it look deleted while the login survived:
 *
 *  - `removePortalAccess` read only `profile_roles`, so an account whose role lives on the
 *    legacy `profiles.role` column reported "no_role", the data was purged, and the auth
 *    user and profile stayed behind.
 *  - `deleteOwnPortalAccount` reported success whenever no roles remained, even when nothing
 *    had actually removed the login.
 *
 * The fix for the first was to UNION the legacy role into the stored list, which opened the
 * opposite hole: `profiles.role` is the role the account was created as and keeps forever, so an
 * account whose stored roles are `[admin]` and whose legacy label still reads `resident` looked
 * like it held a resident portal. Removing its real portal then "left" that phantom behind and the
 * login survived. The stored rows are now the whole answer, and the legacy value only SUBSTITUTES
 * for an empty list — the pre-`profile_roles` account it was added for.
 */

type Row = Record<string, unknown>;

function mockDb(options: {
  roleRows: { role: string }[];
  legacyRole?: string | null;
  deleteUser?: ReturnType<typeof vi.fn>;
}) {
  const deleted: { table: string; column: string; value: unknown }[] = [];
  const updated: { table: string; patch: Row }[] = [];
  const deleteUser = options.deleteUser ?? vi.fn(async () => ({ error: null }));

  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          const result =
            table === "profile_roles" ? { data: options.roleRows, error: null } : { data: null, error: null };
          return Object.assign(Promise.resolve(result), {
            maybeSingle: async () => ({
              data: table === "profiles" ? { role: options.legacyRole ?? null } : null,
              error: null,
            }),
            eq: () => Promise.resolve(result),
            _column: column,
            _value: value,
          });
        },
      }),
      delete: () => ({
        eq: (column: string, value: unknown) => {
          deleted.push({ table, column, value });
          return Object.assign(Promise.resolve({ error: null }), {
            eq: async () => {
              deleted.push({ table, column: "role", value: "second-eq" });
              return { error: null };
            },
          });
        },
      }),
      update: (patch: Row) => ({
        eq: async () => {
          updated.push({ table, patch });
          return { error: null };
        },
      }),
    }),
    auth: { admin: { deleteUser } },
  };

  return { db, deleted, updated, deleteUser };
}

describe("removePortalAccess", () => {
  it("deletes the login when the only role lives on the legacy profiles.role column", async () => {
    const { db, deleteUser } = mockDb({ roleRows: [], legacyRole: "manager" });

    const result = await removePortalAccess(db as never, "legacy-manager", "manager");

    expect(result.mode).toBe("deleted_auth_user");
    expect(deleteUser).toHaveBeenCalledWith("legacy-manager");
  });

  it("deletes the login when a stale legacy label is the only thing left", async () => {
    // Stored roles are [manager]; `profiles.role` still reads "resident" from however the account
    // was created. Removing manager leaves NO portal, so the login has to go — treating the stale
    // label as a surviving resident portal is what kept the address un-reusable.
    const { db, deleteUser } = mockDb({ roleRows: [{ role: "manager" }], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "stale-label", "manager");

    expect(result.mode).toBe("deleted_auth_user");
    expect(deleteUser).toHaveBeenCalledWith("stale-label");
  });

  it("keeps the login when another STORED role remains", async () => {
    const { db, deleteUser, updated } = mockDb({
      roleRows: [{ role: "manager" }, { role: "resident" }],
      legacyRole: "manager",
    });

    const result = await removePortalAccess(db as never, "dual", "manager");

    expect(result.mode).toBe("revoked_role");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(updated.some((entry) => entry.table === "profiles" && entry.patch.role === "resident")).toBe(true);
  });

  it("removes the admin portal of an admin-only account whose legacy label reads resident", async () => {
    const { db, deleteUser } = mockDb({ roleRows: [{ role: "admin" }], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "ops", "admin");

    expect(result.mode).toBe("deleted_auth_user");
    expect(deleteUser).toHaveBeenCalledWith("ops");
  });

  it("still reports no_role when the account never held that portal", async () => {
    const { db, deleteUser } = mockDb({ roleRows: [{ role: "resident" }], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "resident-only", "manager");

    expect(result.mode).toBe("no_role");
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("leaves a legacy-only account's unrelated portal alone", async () => {
    const { db, deleteUser } = mockDb({ roleRows: [], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "legacy-resident", "manager");

    expect(result.mode).toBe("no_role");
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe("heldPortalRoles", () => {
  it("answers with the stored rows and never adds the legacy label to them", () => {
    expect(heldPortalRoles([{ role: "admin" }], "resident")).toEqual(["admin"]);
    expect(heldPortalRoles([{ role: "manager" }], "resident")).toEqual(["manager"]);
    expect(heldPortalRoles([{ role: "resident" }, { role: "manager" }], "admin")).toEqual(["resident", "manager"]);
  });

  it("substitutes the legacy label only for an account with no stored role at all", () => {
    expect(heldPortalRoles([], "manager")).toEqual(["manager"]);
    expect(heldPortalRoles(null, "resident")).toEqual(["resident"]);
    expect(heldPortalRoles(undefined, null)).toEqual([]);
    expect(heldPortalRoles([], "")).toEqual([]);
  });

  it("normalizes case and whitespace, and drops duplicates and blanks", () => {
    expect(heldPortalRoles([{ role: " Manager " }, { role: "MANAGER" }, { role: "" }], null)).toEqual(["manager"]);
    expect(heldPortalRoles([], "  Resident  ")).toEqual(["resident"]);
  });
});
