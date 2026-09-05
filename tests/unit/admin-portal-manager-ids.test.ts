import { describe, expect, it } from "vitest";
import { listAdminPortalManagerUserIds } from "@/lib/auth/admin-portal-manager-ids.server";

function mockDb(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const state = { filters: [] as Array<{ col: string; val: unknown; op: string }> };
      const resolveRows = () =>
        (tables[table] ?? []).filter((row) => {
          const record = row as Record<string, unknown>;
          return state.filters.every((filter) => {
            if (filter.op === "eq") return record[filter.col] === filter.val;
            if (filter.op === "not" && filter.val === null) {
              return record[filter.col] != null && record[filter.col] !== "";
            }
            return true;
          });
        });
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          state.filters.push({ col, val, op: "eq" });
          return chain;
        },
        not: (col: string, _op: string, val: unknown) => {
          state.filters.push({ col, val, op: "not" });
          return chain;
        },
        in: () => chain,
        limit: () => Promise.resolve({ data: resolveRows(), error: null }),
      };
      return chain;
    },
  };
}

describe("listAdminPortalManagerUserIds", () => {
  it("includes managers linked only through purchases or manager_id", async () => {
    const ambikaId = "c49d02b1-7e99-4484-9986-b3b4550c3519";
    const db = mockDb({
      profile_roles: [{ user_id: "mgr-role-only", role: "manager" }],
      profiles: [
        { id: "mgr-role-only", role: "resident", manager_id: null },
        { id: ambikaId, role: "resident", manager_id: "PROPLANE-AMB1" },
      ],
      manager_purchases: [{ user_id: ambikaId }],
    });

    const ids = await listAdminPortalManagerUserIds(db as never);
    expect(ids).toContain("mgr-role-only");
    expect(ids).toContain(ambikaId);
  });
});
