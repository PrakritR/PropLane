import { describe, expect, it, vi } from "vitest";
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

  it("keeps the login when the legacy role is not the one being removed", async () => {
    const { db, deleteUser, updated } = mockDb({ roleRows: [{ role: "manager" }], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "dual", "manager");

    expect(result.mode).toBe("revoked_role");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(updated.some((entry) => entry.table === "profiles" && entry.patch.role === "resident")).toBe(true);
  });

  it("still reports no_role when the account never held that portal", async () => {
    const { db, deleteUser } = mockDb({ roleRows: [{ role: "resident" }], legacyRole: "resident" });

    const result = await removePortalAccess(db as never, "resident-only", "manager");

    expect(result.mode).toBe("no_role");
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
