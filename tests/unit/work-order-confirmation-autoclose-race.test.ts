import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const events = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: events }));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => ({ autoCloseHours: 1 }) }));
import { autoCloseResidentConfirmations } from "@/lib/work-order-resident-confirmation.server";

function fixture(terminal: boolean, race: boolean) {
  const row = { id: "job", manager_user_id: "manager", resident_user_id: "resident", row_revision: 3, updated_at: "2026-01-01", row_data: { bucket: terminal ? "completed" : "scheduled", status: terminal ? "Completed" : "Scheduled", residentConfirmation: { tokenId: "digest", requestedAt: "2026-01-01T00:00:00Z" } } };
  let writes = 0;
  const db = { from() {
    let patch: Record<string, unknown> | null = null; const filters: Array<(value: typeof row) => boolean> = [];
    const q = { select: () => q, not: () => q, limit: () => q, contains: () => q,
      eq: (key: string, value: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[key] === value); return q; },
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => { if (race) row.row_revision++; if (!filters.every((f) => f(row))) return { data: null, error: null }; if (patch) writes++; return { data: { id: row.id }, error: null }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ ...row, row_data: { ...row.row_data } }], error: null }).then(resolve),
    }; return q;
  } };
  return { db, writes: () => writes };
}
it("does not autoclose or notify for a terminal job", async () => {
  events.mockClear(); const f = fixture(true, false);
  expect(await autoCloseResidentConfirmations(f.db as never, new Date("2026-01-03"))).toBe(0);
  expect(f.writes()).toBe(0); expect(events).not.toHaveBeenCalled();
});
it("does not overwrite a job changed after the autoclose scan", async () => {
  events.mockClear(); const f = fixture(false, true);
  expect(await autoCloseResidentConfirmations(f.db as never, new Date("2026-01-03"))).toBe(0);
  expect(f.writes()).toBe(0); expect(events).not.toHaveBeenCalled();
});
