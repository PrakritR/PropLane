import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => ({ residentConfirmation: true }) }));
import { requestResidentConfirmation } from "@/lib/work-order-resident-confirmation.server";

function fixture(terminal: boolean, race: boolean) {
  const row = { id: "job", manager_user_id: "manager", resident_user_id: "resident", row_revision: 2, row_data: { bucket: terminal ? "completed" : "scheduled", residentEmail: "resident@example.test" } };
  let writes = 0;
  const db = { from() {
    let patch: Record<string, unknown> | null = null; const filters: Array<(value: typeof row) => boolean> = [];
    const q = { select: () => q, eq: (key: string, value: unknown) => { filters.push((r) => (r as unknown as Record<string, unknown>)[key] === value); return q; },
      update: (value: Record<string, unknown>) => { patch = value; return q; },
      maybeSingle: async () => { if (patch && race) row.row_revision++; if (!filters.every((f) => f(row))) return { data: null, error: null }; if (patch) { writes++; return { data: { id: row.id }, error: null }; } return { data: { ...row }, error: null }; },
    }; return q;
  } };
  return { db, writes: () => writes };
}
it("does not issue a confirmation for an independently completed job", async () => {
  const f = fixture(true, false);
  expect(await requestResidentConfirmation(f.db as never, "job", "manager")).toBeNull();
  expect(f.writes()).toBe(0);
});
it("refuses the confirmation stamp when the job changed after its read", async () => {
  const f = fixture(false, true);
  expect(await requestResidentConfirmation(f.db as never, "job", "manager")).toBeNull();
  expect(f.writes()).toBe(0);
});
it("issues a confirmation for an unchanged bound service", async () => {
  const f = fixture(false, false);
  expect(await requestResidentConfirmation(f.db as never, "job", "manager")).toMatchObject({ confirmUrl: expect.any(String) });
  expect(f.writes()).toBe(1);
});
