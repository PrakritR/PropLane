import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const events = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: events }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => [] }));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => null }));
import { rateResidentConfirmation } from "@/lib/work-order-resident-confirmation.server";

function fixture(race: boolean) {
  const row = { id: "job", manager_user_id: "manager", vendor_user_id: null, row_revision: 3, updated_at: "2026-01-01", row_data: { bucket: "completed", status: "Completed", residentConfirmation: { tokenId: "digest", requestedAt: new Date().toISOString(), respondedAt: new Date().toISOString(), verdict: "fixed" } } };
  let writes = 0;
  const db = { from(table: string) {
    const filters: Array<(value: typeof row) => boolean> = []; let patch: Record<string, unknown> | null = null;
    const q = { select: () => q, limit: () => q, contains: () => q, eq: (key: string, value: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[key] === value); return q; },
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => {
        if (table === "profiles") return { data: null, error: null };
        if (patch && race) row.row_revision++;
        if (!filters.every((f) => f(row))) return { data: null, error: null };
        if (patch) { writes++; Object.assign(row, patch); return { data: { id: row.id }, error: null }; }
        return { data: { ...row, row_data: { ...row.row_data } }, error: null };
      },
    }; return q;
  } };
  return { db, writes: () => writes };
}
it("allows a rating after fixed completes the service", async () => {
  events.mockClear(); const f = fixture(false);
  expect(await rateResidentConfirmation(f.db as never, { token: "token", rating: 5 })).toEqual({ ok: true });
  expect(f.writes()).toBe(1); expect(events).toHaveBeenCalledTimes(1);
});
it("refuses a rating snapshot changed by a concurrent completion", async () => {
  events.mockClear(); const f = fixture(true);
  expect(await rateResidentConfirmation(f.db as never, { token: "token", rating: 5 })).toEqual({ ok: false, reason: "invalid" });
  expect(f.writes()).toBe(0); expect(events).not.toHaveBeenCalled();
});
