/**
 * AGENTS.md § Financials: "Ledger is write-through (`syncLedger*`)". One failing row must not cost the rest of the
 * batch its ledger line, and a charge whose ROW landed is never reported as a failure: the caller is told which
 * charges are missing their ledger line (`ledgerFailures`) so it can say so without inviting a second charge. The
 * precedent in this repo is the late-fee path in `/api/cron/send-payment-reminders`, which counts the fee as
 * created and records the ledger failure beside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ledger: vi.fn(async () => undefined),
  emit: vi.fn(async () => undefined),
  reconcile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/reports/ledger-sync", () => ({
  syncLedgerChargeEntry: h.ledger,
  reconcileDuplicateHouseholdChargeRecords: h.reconcile,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: h.emit }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: async () => undefined,
  restoreFuturePaymentRemindersForCharge: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {},
  loadManagerAutomationSettings: async () => ({}),
}));
vi.mock("@/lib/payment-reminder-bootstrap", () => ({
  ensureChargeDueDateForReminders: (charge: { dueDateLabel?: string }) => charge,
}));

import { upsertManagerCharges } from "@/lib/household-charges.server";

const MANAGER = "11111111-1111-1111-1111-111111111111";

const charge = (id: string) => ({
  id,
  kind: "rent",
  status: "pending",
  amountLabel: "$100.00",
  balanceLabel: "$100.00",
  dueDateLabel: "2026-03-01",
  residentEmail: "r@test.com",
  propertyId: "prop-1",
  propertyLabel: "Lakeview",
  managerUserId: MANAGER,
  title: "Rent — March 2026",
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Reads find no stored row (so every charge is new); every write succeeds. */
function fakeDb(): never {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          return (onFulfilled?: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onFulfilled);
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

beforeEach(() => {
  h.ledger.mockReset();
  h.emit.mockReset();
  h.reconcile.mockReset();
  h.ledger.mockResolvedValue(undefined);
  h.emit.mockResolvedValue(undefined);
  h.reconcile.mockResolvedValue(undefined);
});

describe("upsertManagerCharges: the write-through ledger", () => {
  it("names the charge whose ledger line could not be written, after trying every other row", async () => {
    h.ledger.mockImplementation(async (_db: unknown, c: unknown) => {
      if ((c as { id: string }).id === "chg-2") throw new Error("ledger_entries unavailable");
    });

    const result = await upsertManagerCharges(fakeDb(), MANAGER, [charge("chg-1"), charge("chg-2"), charge("chg-3")]);
    expect(result).toEqual({ ledgerFailures: ["chg-2"] });

    expect(h.ledger.mock.calls.map((call) => (call[1] as { id: string }).id)).toEqual(["chg-1", "chg-2", "chg-3"]);
    expect(h.emit.mock.calls.map((call) => (call[1] as { charge: { id: string } }).charge.id)).toEqual([
      "chg-1",
      "chg-2",
      "chg-3",
    ]);
  });

  it("names none when every ledger line is written", async () => {
    await expect(upsertManagerCharges(fakeDb(), MANAGER, [charge("chg-1"), charge("chg-2")])).resolves.toEqual({
      ledgerFailures: [],
    });
    expect(h.ledger).toHaveBeenCalledTimes(2);
  });
});
