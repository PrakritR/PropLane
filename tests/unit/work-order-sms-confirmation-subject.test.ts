import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const events = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: events }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => [] }));
import { resolveResidentConfirmationBySms } from "@/lib/work-order-resident-confirmation.server";

function fixture(owner: string, race = false) {
  const row = { id: "job", manager_user_id: "manager", resident_user_id: owner, resident_email: "same@example.test", vendor_user_id: null, updated_at: "2026-01-01T00:00:00.123456+00:00", row_data: { title: "Leak", residentEmail: "same@example.test", residentConfirmation: { tokenId: "hash", requestedAt: new Date().toISOString() } } };
  let writes = 0;
  const db = { from(table: string) {
    const filters: Array<(r: typeof row) => boolean> = []; let patch: Record<string, unknown> | null = null;
    const q = { select: () => q, eq: (key: string, value: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[key] === value); return q; }, not: () => q, order: () => q, limit: () => q,
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => { if (patch && race) row.updated_at = "2026-01-02T00:00:00.000000+00:00"; const matches = filters.every((f) => f(row)); if (patch && matches) { writes++; Object.assign(row, patch); } return { data: table === "profiles" ? null : matches ? { id: row.id } : null, error: null }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === "portal_work_order_records" && filters.every((f) => f(row)) ? [row] : [], error: null }).then(resolve),
    }; return q;
  } };
  return { db, writes: () => writes };
}
it("denies reused-email or missing subject without update or notice", async () => {
  events.mockClear(); const f = fixture("original");
  expect(await resolveResidentConfirmationBySms(f.db as never, { managerUserId: "manager", residentUserId: "replacement", verdict: "fixed" })).toBeNull();
  expect(await resolveResidentConfirmationBySms(f.db as never, { managerUserId: "manager", residentEmail: "same@example.test", verdict: "fixed" })).toBeNull();
  expect(f.writes()).toBe(0); expect(events).not.toHaveBeenCalled();
});
it("allows the bound subject and writes before notification", async () => {
  events.mockClear(); const f = fixture("original");
  expect(await resolveResidentConfirmationBySms(f.db as never, { managerUserId: "manager", residentUserId: "original", verdict: "fixed" })).toMatchObject({ ok: true });
  expect(f.writes()).toBe(1); expect(events).toHaveBeenCalledTimes(1);
});

it("rejects a concurrent changed confirmation without emitting a notice", async () => {
  events.mockClear(); const f = fixture("original", true);
  expect(await resolveResidentConfirmationBySms(f.db as never, { managerUserId: "manager", residentUserId: "original", verdict: "fixed" })).toBeNull();
  expect(f.writes()).toBe(0); expect(events).not.toHaveBeenCalled();
});
