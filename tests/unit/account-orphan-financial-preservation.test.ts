import { expect, it, vi } from "vitest";
import { loadPortalAccountIndex, purgeOrphanedPortalRecords } from "@/lib/auth/purge-orphaned-portal-records";
vi.mock("@/lib/auth/purge-orphaned-co-manager-links", () => ({ purgeOrphanedCoManagerLinks: async () => ({ deleted: { portal_pro_relationship_records: 0, account_link_invites: 0 } }) }));

function database(profiles: unknown[], roles: unknown[] = [], fail = false) {
  const from = vi.fn((table: string) => {
    let start = 0, end = 99;
    const query = {
      select: () => query, order: () => query,
      range: (a: number, b: number) => { start = a; end = b; return query; },
      then: (resolve: (result: unknown) => unknown) => resolve({
        data: (table === "profiles" ? profiles : table === "profile_roles" ? roles : []).slice(start, end + 1),
        error: fail ? { code: "42501", message: "permission denied" } : null,
      }),
    };
    return query;
  });
  return { from } as unknown as Parameters<typeof loadPortalAccountIndex>[0] & { from: typeof from };
}

it("admin orphan cleanup never targets surviving financial or lease history", async () => {
  const db = database([{ id: "manager", email: "manager@example.test", role: "manager" }]);
  await purgeOrphanedPortalRecords(db);
  for (const table of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans", "portal_household_charge_records", "portal_lease_pipeline_records"]) {
    expect(db.from).not.toHaveBeenCalledWith(table);
  }
});

it("includes accounts beyond the first index page and unions legacy and additional roles", async () => {
  const profiles = Array.from({ length: 201 }, (_, i) => ({ id: `user-${i}`, email: `user-${i}@example.test`, role: "resident" }));
  const db = database(profiles, [{ user_id: "user-200", role: "owner" }]);
  const index = await loadPortalAccountIndex(db);
  expect(index.residentUserIds.size).toBe(201);
  expect(index.residentEmails.has("user-200@example.test")).toBe(true);
  expect(index.managerEmails.has("user-200@example.test")).toBe(true);
});

it("stops instead of treating a failed identity lookup as evidence every account was deleted", async () => {
  const db = database([], [], true);
  await expect(purgeOrphanedPortalRecords(db)).rejects.toThrow(/permission denied/);
  expect(db.from.mock.calls.every(([table]) => table === "profiles" || table === "profile_roles")).toBe(true);
});
