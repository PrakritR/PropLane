import { describe, expect, it } from "vitest";
import { filterAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

/**
 * In-memory stand-in for the Supabase client covering the query shapes
 * filterAdminUserIds uses:
 *   from(table).select(cols).eq(col, val).in(col, arr) -> await -> { data }
 *   from(table).select(cols).in(col, arr)              -> await -> { data }
 */
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeDb(tables: Tables) {
  const rowsFor = (table: string) => tables[table] ?? [];

  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((row) => String(row[col] ?? "") === String(val));
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals.map((v) => String(v)));
        filters.push((row) => set.has(String(row[col] ?? "")));
        return api;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => {
        const data = rowsFor(table).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

describe("userHoldsAdminRole", () => {
  it("accepts an account with the admin role in profile_roles (any email)", async () => {
    const db = makeDb({
      profile_roles: [{ user_id: "u1", role: "admin" }],
      profiles: [{ id: "u1", email: "admin@test.proplane.local", role: "resident" }],
    });
    expect(await userHoldsAdminRole(db, "u1")).toBe(true);
  });

  it("accepts a legacy profiles.role = 'admin' account without a profile_roles row", async () => {
    const db = makeDb({
      profile_roles: [],
      profiles: [{ id: "u2", email: "legacy-admin@test.proplane.local", role: "admin" }],
    });
    expect(await userHoldsAdminRole(db, "u2")).toBe(true);
  });

  it("keeps the primary-admin email as an always-admin fallback", async () => {
    const db = makeDb({
      profile_roles: [],
      profiles: [{ id: "u3", email: PRIMARY_ADMIN_EMAIL, role: "manager" }],
    });
    expect(await userHoldsAdminRole(db, "u3")).toBe(true);
  });

  it("does not grant admin to Prakrit's Gmail via the primary-email fallback", async () => {
    const db = makeDb({
      profile_roles: [{ user_id: "prakrit", role: "manager" }],
      profiles: [{ id: "prakrit", email: "prakritramachandran@gmail.com", role: "manager" }],
    });
    expect(await userHoldsAdminRole(db, "prakrit")).toBe(false);
  });

  it("rejects non-admin accounts", async () => {
    const db = makeDb({
      profile_roles: [{ user_id: "u4", role: "manager" }],
      profiles: [{ id: "u4", email: "manager@test.proplane.local", role: "manager" }],
    });
    expect(await userHoldsAdminRole(db, "u4")).toBe(false);
  });

  it("rejects unknown accounts and blank ids", async () => {
    const db = makeDb({ profile_roles: [], profiles: [] });
    expect(await userHoldsAdminRole(db, "missing")).toBe(false);
    expect(await userHoldsAdminRole(db, "  ")).toBe(false);
  });
});

describe("filterAdminUserIds", () => {
  it("returns only the admin-role holders among the given ids", async () => {
    const db = makeDb({
      profile_roles: [
        { user_id: "role-admin", role: "admin" },
        { user_id: "mgr", role: "manager" },
      ],
      profiles: [
        { id: "role-admin", email: "admin@test.proplane.local", role: "resident" },
        { id: "legacy-admin", email: "old@test.proplane.local", role: "admin" },
        { id: "primary", email: PRIMARY_ADMIN_EMAIL, role: "manager" },
        { id: "mgr", email: "manager@test.proplane.local", role: "manager" },
      ],
    });
    const admins = await filterAdminUserIds(db, ["role-admin", "legacy-admin", "primary", "mgr", "ghost"]);
    expect([...admins].sort()).toEqual(["legacy-admin", "primary", "role-admin"]);
  });

  it("returns an empty set for no ids without querying", async () => {
    const db = makeDb({});
    expect((await filterAdminUserIds(db, [])).size).toBe(0);
  });
});
