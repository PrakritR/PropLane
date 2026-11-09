import { expect, it, vi } from "vitest";
import { persistHouseholdChargeRows, type HouseholdChargeWriteRow } from "@/lib/household-charge-persist.server";

vi.mock("@/lib/reports/ledger-sync", () => ({ householdChargeLedgerFingerprint: () => "same", reconcileDuplicateChargeList: vi.fn(), syncLedgerChargeEntry: vi.fn(async () => undefined) }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: vi.fn() }));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: vi.fn(async () => undefined) }));

it("acknowledges equal existing rows but not missing versions, CAS misses or duplicate inserts", async () => {
  const row = (id: string): HouseholdChargeWriteRow => ({ id, manager_user_id: "owner", resident_user_id: null, resident_email: "r@example.invalid", property_id: "p", kind: "rent", status: "pending", row_data: { id }, updated_at: "now" });
  const equal = row("equal"), noVersion = row("no-version"), cas = row("cas"), duplicate = row("duplicate");
  const select = vi.fn().mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: null, error: { code: "23505" } });
  const query = { update: vi.fn(), insert: vi.fn(), eq: vi.fn(), select };
  query.update.mockReturnValue(query); query.insert.mockReturnValue(query); query.eq.mockReturnValue(query);
  const db = { from: () => query } as never;
  const result = await persistHouseholdChargeRows(db, [equal, noVersion, cas, duplicate], {
    actor: { id: "owner", role: "manager" }, now: "now", chargeIds: ["equal", "no-version", "cas", "duplicate"],
    previousStatusById: new Map([["equal", "pending"], ["no-version", "pending"], ["cas", "pending"]]),
    existingOwnerById: new Map([["equal", "owner"], ["no-version", "owner"], ["cas", "owner"]]),
    existingUpdatedAtById: new Map([["cas", "old"]]),
    existingRecordById: new Map([["equal", equal as unknown as Record<string, unknown>]]),
    existingLedgerFingerprintById: new Map(),
  });
  expect(result.confirmedIds).toEqual(["equal"]);
  expect(result.persistedRows).toEqual([]);
  expect(result.chargeWriteError).toBeNull();
});

it.each(["removed", "reconcile failure"])("does not acknowledge a persisted row after %s", async (result) => {
  const { reconcileDuplicateChargeList } = await import("@/lib/reports/ledger-sync");
  if (result === "removed") vi.mocked(reconcileDuplicateChargeList).mockResolvedValueOnce({ removedChargeIds: ["new"] });
  else vi.mocked(reconcileDuplicateChargeList).mockRejectedValueOnce(new Error("unavailable"));
  const row: HouseholdChargeWriteRow = { id: "new", manager_user_id: "owner", resident_user_id: null, resident_email: null, property_id: "p", kind: "rent", status: "pending", row_data: { id: "new" }, updated_at: "now" };
  const db = { from: () => ({ insert: () => ({ select: async () => ({ data: [{ id: "new" }], error: null }) }) }) } as never;
  const saved = await persistHouseholdChargeRows(db, [row], {
    actor: { id: "owner", role: "manager" }, now: "now", chargeIds: ["new"],
    previousStatusById: new Map(), existingOwnerById: new Map(), existingUpdatedAtById: new Map(),
    existingRecordById: new Map(), existingLedgerFingerprintById: new Map(),
  });
  expect(saved.persistedRows).toHaveLength(1);
  expect(saved.confirmedIds).toEqual([]);
});
