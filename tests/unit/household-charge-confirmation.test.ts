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

it.each(["removed", "reconcile failure"])("excludes only known or uncertain duplicate IDs after %s", async (outcome) => {
  const { reconcileDuplicateChargeList, syncLedgerChargeEntry } = await import("@/lib/reports/ledger-sync");
  const { emitHouseholdChargeTransition } = await import("@/lib/domain-action-events.server");
  vi.mocked(syncLedgerChargeEntry).mockClear();
  vi.mocked(emitHouseholdChargeTransition).mockClear();
  if (outcome === "removed") vi.mocked(reconcileDuplicateChargeList).mockResolvedValueOnce({ removedChargeIds: ["old"] });
  else vi.mocked(reconcileDuplicateChargeList).mockRejectedValueOnce(new Error("unavailable"));
  const row = (id: string, propertyId: string, createdAt: string): HouseholdChargeWriteRow => ({ id, manager_user_id: "owner", resident_user_id: null, resident_email: "r@example.invalid", property_id: propertyId, kind: "rent", status: "pending", row_data: { id, managerUserId: "owner", residentEmail: "r@example.invalid", propertyId, kind: "rent", status: "pending", createdAt }, updated_at: "now" });
  const input = [row("old", "p", "2026-01-01"), row("new", "p", "2026-02-01"), row("other", "q", "2026-01-01")];
  const db = { from: () => ({ insert: () => ({ select: async () => ({ data: [{ id: "saved" }], error: null }) }) }) } as never;
  const saved = await persistHouseholdChargeRows(db, input, {
    actor: { id: "owner", role: "manager" }, now: "now", chargeIds: input.map((entry) => entry.id),
    previousStatusById: new Map(), existingOwnerById: new Map(), existingUpdatedAtById: new Map(),
    existingRecordById: new Map(), existingLedgerFingerprintById: new Map(),
  });
  expect(saved.confirmedIds).toEqual(["new", "other"]);
  expect(vi.mocked(syncLedgerChargeEntry).mock.calls.map((call) => call[1].id)).toEqual(["new", "other"]);
  expect(vi.mocked(emitHouseholdChargeTransition).mock.calls.map((call) => call[1].charge.id)).toEqual(["new", "other"]);
});
