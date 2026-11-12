/**
 * Charging several residents of one house at once, and exactly one notice per charge.
 *
 * The Add charge modal never sends a notice of its own: every persisted row fires `charge_created` (card, SMS with that
 * charge's pay link, email) through `persistHouseholdChargeRows`, the one write path. So N residents = N charges = N
 * notices, each through the resident's own channel rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ledger: vi.fn(async (..._a: unknown[]) => undefined),
  emit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/lib/reports/ledger-sync", () => ({
  syncLedgerChargeEntry: h.ledger,
  householdChargeLedgerFingerprint: () => "fp",
  reconcileDuplicateChargeList: async () => ({ removedChargeIds: [] }),
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: h.emit }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: async () => undefined }));

import {
  EVERYONE_IN_HOUSE,
  chargeIdForResident,
  chargesAddedMessage,
  createChargesForResidents,
  nextResidentSelection,
  pickerSelection,
  type BatchChargeResident,
} from "@/lib/manager-charge-batch";
import { persistHouseholdChargeRows, type HouseholdChargeWriteRow } from "@/lib/household-charge-persist.server";
import type { HouseholdCharge } from "@/lib/household-charges";
import { chargeEventSmsWithPayLink, isPayRequestPaymentEvent } from "@/lib/payments/charge-event-pay-link.server";

const HOUSE = ["a1", "a2", "a3"];

const resident = (n: number): BatchChargeResident => ({
  applicationId: `a${n}`,
  residentName: `Resident ${n}`,
  residentEmail: `r${n}@example.com`,
  propertyId: "prop-1",
  propertyLabel: "Lakeview",
  title: `Cleaning fee — Unit ${n}`,
});

describe("the resident picker", () => {
  it("ticking Everyone in this house ticks every resident of the house", () => {
    expect(nextResidentSelection([], [EVERYONE_IN_HOUSE], HOUSE)).toEqual(HOUSE);
  });

  it("unticking Everyone clears them all", () => {
    const shown = pickerSelection(HOUSE, HOUSE);
    expect(shown).toEqual([EVERYONE_IN_HOUSE, ...HOUSE]);
    expect(nextResidentSelection(shown, HOUSE, HOUSE)).toEqual([]);
  });

  it("unticking one resident drops Everyone and keeps the rest; ticking the last one by hand shows Everyone", () => {
    const shown = pickerSelection(HOUSE, HOUSE);
    const afterUntick = nextResidentSelection(shown, [EVERYONE_IN_HOUSE, "a1", "a3"], HOUSE);
    expect(afterUntick).toEqual(["a1", "a3"]);
    expect(pickerSelection(afterUntick, HOUSE)).toEqual(["a1", "a3"]);
    const all = nextResidentSelection(["a1", "a3"], ["a1", "a3", "a2"], HOUSE);
    expect(all).toEqual(HOUSE);
    expect(pickerSelection(all, HOUSE)[0]).toBe(EVERYONE_IN_HOUSE);
  });

  it("never returns a resident who is not in this house", () => {
    expect(nextResidentSelection([], ["a1", "stranger"], HOUSE)).toEqual(["a1"]);
  });
});

describe("createChargesForResidents", () => {
  const terms = { managerUserId: "mgr-1", amount: 75, dueDateLabel: "Dec 1, 2026", initialStatus: "pending" as const, baseId: "hc_mgr_1_abc" };

  it("N residents = N charges through the ONE existing creator, same amount and due date, a distinct id each", () => {
    const create = vi.fn((input: { id?: string; residentEmail: string }) => ({ id: input.id, residentEmail: input.residentEmail }) as unknown as HouseholdCharge);
    const { created, failed } = createChargesForResidents([resident(1), resident(2), resident(3)], terms, create as never);
    expect(create).toHaveBeenCalledTimes(3);
    expect(created).toHaveLength(3);
    expect(failed).toHaveLength(0);
    const ids = create.mock.calls.map((c) => c[0]!.id);
    expect(new Set(ids).size).toBe(3);
    for (const call of create.mock.calls) {
      expect(call[0]).toMatchObject({ amount: 75, dueDateLabel: "Dec 1, 2026", initialStatus: "pending", managerUserId: "mgr-1" });
    }
    expect(create.mock.calls.map((c) => c[0]!.residentEmail)).toEqual(["r1@example.com", "r2@example.com", "r3@example.com"]);
  });

  it("one resident keeps the minted id exactly as before; a retried submit reuses the same ids", () => {
    expect(chargeIdForResident("hc_mgr_1_abc", 0, 1)).toBe("hc_mgr_1_abc");
    expect(chargeIdForResident("hc_mgr_1_abc", 1, 3)).toBe(chargeIdForResident("hc_mgr_1_abc", 1, 3));
  });

  it("a resident the creator refuses is reported, the rest are still added", () => {
    const create = vi.fn((input: { residentEmail: string }) => (input.residentEmail === "r2@example.com" ? null : ({ id: "x" } as unknown as HouseholdCharge)));
    const { created, failed } = createChargesForResidents([resident(1), resident(2)], terms, create as never);
    expect(created).toHaveLength(1);
    expect(failed.map((r) => r.applicationId)).toEqual(["a2"]);
  });

  it("one confirmation with a count", () => {
    expect(chargesAddedMessage(1)).toBe("Charge added.");
    expect(chargesAddedMessage(3)).toBe("3 charges added.");
  });
});

describe("N charges, N notices, one write path", () => {
  beforeEach(() => {
    h.ledger.mockClear();
    h.emit.mockClear();
  });

  it("persistHouseholdChargeRows writes each new row once to the ledger and fires charge_created once for it", async () => {
    const rows: HouseholdChargeWriteRow[] = [1, 2, 3].map((n) => ({
      id: `hc_${n}`,
      manager_user_id: "mgr-1",
      resident_user_id: null,
      resident_email: `r${n}@example.com`,
      property_id: "prop-1",
      kind: "other_cost",
      status: "pending",
      row_data: { id: `hc_${n}`, kind: "other_cost", status: "pending", residentEmail: `r${n}@example.com`, managerUserId: "mgr-1" },
      updated_at: "2026-11-12T00:00:00.000Z",
    }));
    const db = { from: () => ({ insert: (row: { id: string }) => ({ select: async () => ({ data: [{ id: row.id }], error: null }) }) }) };
    const { persistedRows } = await persistHouseholdChargeRows(db as never, rows, {
      actor: { id: "mgr-1", role: "manager" },
      now: "2026-11-12T00:00:00.000Z",
      chargeIds: rows.map((r) => r.id),
      previousStatusById: new Map(),
      existingOwnerById: new Map(),
      existingUpdatedAtById: new Map(),
      existingRecordById: new Map(),
      existingLedgerFingerprintById: new Map(),
    });
    expect(persistedRows).toHaveLength(3);
    expect(h.ledger).toHaveBeenCalledTimes(3);
    expect(h.emit).toHaveBeenCalledTimes(3);
    const emitted = h.emit.mock.calls.map((c) => (c[1] as { charge: { id: string }; previousStatus: unknown }).charge.id);
    expect(emitted).toEqual(["hc_1", "hc_2", "hc_3"]);
    for (const call of h.emit.mock.calls) expect((call[1] as { previousStatus: unknown }).previousStatus).toBeNull();
  });
});

describe("one notice per added charge, carrying the charge's own pay link", () => {
  const modal = readFileSync(join(__dirname, "../../src/components/portal/pro-add-payment-modal.tsx"), "utf8");

  it("the Add charge modal sends no notice of its own", () => {
    expect(modal).not.toMatch(/deliverPortalInboxMessage/);
    expect(modal).not.toMatch(/buildNewChargeNoticeBody/);
    expect(modal).not.toMatch(/PortalNotificationPreviewModal/);
    expect(modal).not.toMatch(/\/api\/(portal\/)?send-inbox-message/);
  });

  it("it adds through the batch helper over the one creator, with a multi-select (no pills, no subtext)", () => {
    expect(modal).toMatch(/createChargesForResidents/);
    expect(modal).not.toMatch(/\bcreateManagerCharge\b/);
    expect(modal).toMatch(/WizardMultiSelect/);
    expect(modal).toMatch(/Everyone in this house/);
    expect(modal).not.toMatch(/<Badge\b/);
  });

  it("charge_created is a pay request: its resident text is rewritten with the charge-specific pay link", async () => {
    expect(isPayRequestPaymentEvent("payment", "charge_created")).toBe(true);
    expect(isPayRequestPaymentEvent("payment", "payment_received")).toBe(false);
    // Unknown charge: the ordinary text stays (null = no rewrite), never a throw.
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    expect(await chargeEventSmsWithPayLink(db as never, { managerUserId: "m", chargeId: "c", text: "A new charge." })).toBeNull();
  });
});
