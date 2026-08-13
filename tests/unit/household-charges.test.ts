import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chargeDueLabel,
  chargeVisibleToManager,
  compareChargesByDueDate,
  compareDueDateMs,
  dedupeHouseholdCharges,
  duplicateHouseholdChargeIds,
  householdChargeToLedgerRow,
  isHouseholdChargeOverdue,
  isManagerAddedOneOffCharge,
  joinPropertyAndUnitLabel,
  mergeHouseholdChargesWithServer,
} from "@/lib/household-charges";
import type { HouseholdCharge } from "@/lib/household-charges";

function makeCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "chg-1",
    kind: "rent",
    status: "pending",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    dueDateLabel: "Mar 1, 2026",
    residentEmail: "r@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    managerUserId: "mgr-1",
    rentMonth: "2026-03",
    createdAt: "2026-01-01T00:00:00.000Z",
    title: "Rent — March 2026",
    ...overrides,
  } as HouseholdCharge;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("household-charges pure helpers", () => {
  it("detects overdue charges", () => {
    const overdue = makeCharge({ dueDateLabel: "Jan 1, 2020" });
    expect(isHouseholdChargeOverdue(overdue, new Date("2026-06-01"))).toBe(true);
    expect(isHouseholdChargeOverdue(makeCharge({ status: "paid" }), new Date("2026-06-01"))).toBe(false);
  });

  it("returns due label", () => {
    expect(chargeDueLabel(makeCharge({ dueDateLabel: "Due tomorrow" }))).toBe("Due tomorrow");
  });

  it("filters charges visible to manager", () => {
    expect(chargeVisibleToManager(makeCharge({ managerUserId: "mgr-1" }), "mgr-1")).toBe(true);
    expect(chargeVisibleToManager(makeCharge({ managerUserId: "mgr-2" }), "mgr-1")).toBe(false);
  });

  it("maps paid charges to the paid bucket even when due date is in the past", () => {
    const paid = makeCharge({
      status: "paid",
      paidAt: "2026-06-01T12:00:00.000Z",
      amountLabel: "$1,500.00",
      balanceLabel: "$0.00",
      dueDateLabel: "Jan 1, 2020",
    });
    expect(householdChargeToLedgerRow(paid).bucket).toBe("paid");
    expect(householdChargeToLedgerRow(paid).statusLabel).toBe("Paid");
    // The Amount column binds to the FACE amount, not the outstanding balance —
    // a paid charge's balance is $0.00, which used to make every Paid row read $0.
    expect(householdChargeToLedgerRow(paid).lineAmount).toBe("$1,500.00");
    expect(householdChargeToLedgerRow(paid).lineAmount).not.toBe("$0.00");
  });

  it("orders due-date timestamps ascending/descending with undated rows last", () => {
    const jan = new Date("2026-01-15").getTime();
    const jun = new Date("2026-06-15").getTime();
    // Ascending: earlier date first.
    expect(compareDueDateMs(jan, jun, "asc")).toBeLessThan(0);
    // Descending: later date first.
    expect(compareDueDateMs(jan, jun, "desc")).toBeGreaterThan(0);
    // Undated (null) always sorts after a dated row, regardless of direction.
    expect(compareDueDateMs(null, jun, "asc")).toBeGreaterThan(0);
    expect(compareDueDateMs(jun, null, "asc")).toBeLessThan(0);
    expect(compareDueDateMs(null, jun, "desc")).toBeGreaterThan(0);
    expect(compareDueDateMs(null, null, "asc")).toBe(0);
  });

  it("sorts a paid ledger most-recent-first and pending soonest-first by due date", () => {
    const may = makeCharge({ id: "may", rentMonth: "2026-05", dueDateLabel: "May 1, 2026" });
    const jul = makeCharge({ id: "jul", rentMonth: "2026-07", dueDateLabel: "Jul 1, 2026" });
    const aug = makeCharge({ id: "aug", rentMonth: "2026-08", dueDateLabel: "Aug 1, 2026" });
    const undated = makeCharge({ id: "setup", rentMonth: undefined, dueDateLabel: "Before move-in" });

    const pendingOrder = [aug, undated, may, jul]
      .sort((a, b) => compareChargesByDueDate(a, b, "asc"))
      .map((c) => c.id);
    expect(pendingOrder).toEqual(["may", "jul", "aug", "setup"]);

    const paidOrder = [may, undated, aug, jul]
      .sort((a, b) => compareChargesByDueDate(a, b, "desc"))
      .map((c) => c.id);
    expect(paidOrder).toEqual(["aug", "jul", "may", "setup"]);
  });

  it("dedupes charges hydrated with a missing residentEmail without crashing", () => {
    // Regression: rows hydrated from localStorage/server JSON are cast as
    // HouseholdCharge without validation, so residentEmail/residentName can be
    // undefined. chargeBusinessKey() calls .trim() on residentEmail, which
    // previously threw "undefined is not an object (evaluating 't.trim')" and
    // took down the whole manager Payments tab via the error boundary.
    const missingEmail = makeCharge({
      id: "chg-missing-email",
      residentEmail: undefined as unknown as string,
      residentName: undefined as unknown as string,
    });
    let result: ReturnType<typeof dedupeHouseholdCharges> = [];
    expect(() => {
      result = dedupeHouseholdCharges([missingEmail]);
    }).not.toThrow();
    expect(result).toHaveLength(1);
    // Coerced to "" so every downstream .trim() consumer is safe.
    expect(result[0]!.residentEmail).toBe("");
    expect(result[0]!.residentName).toBe("");
  });
});

describe("syncHouseholdChargesFromServer", () => {
  // The contract a forced sync must keep is about FRESHNESS, not parallelism:
  // it may never be answered by a request that began before it asked, because
  // the caller may have just written a charge. It is free to wait for an
  // in-flight request and then issue its own — and it now does, so that the
  // several panels that force a refresh on mount cost two requests rather than
  // one each (measured: 3 `/api/portal-household-charges` on one
  // `/portal/payments` load).
  it("never serves a forced sync from a request that started before it asked", async () => {
    vi.resetModules();

    const session = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: vi.fn((key: string) => session.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          session.set(key, value);
        }),
      },
      dispatchEvent: vi.fn(),
    });

    let resolveFirst: (value: { ok: true; json: () => Promise<{ charges: HouseholdCharge[]; rentProfiles: [] }> }) => void;
    const firstResponse = new Promise<{ ok: true; json: () => Promise<{ charges: HouseholdCharge[]; rentProfiles: [] }> }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    // Dispatch on METHOD, not call order. A completed sync can write back
    // (`postHouseholdPayload`), and once the reads are sequenced rather than
    // parallel that POST lands between them — a call-ordered mock would hand
    // the second READ the response meant for it and silently pass.
    let reads = 0;
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET").toUpperCase() !== "GET") {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      reads += 1;
      if (reads === 1) return firstResponse;
      return Promise.resolve({
        ok: true,
        // A DIFFERENT bill (own resident + month), so the local-wins merge keeps
        // it alongside mgr-a instead of collapsing the two onto one business key
        // — otherwise this assertion passes for the wrong reason.
        json: async () => ({
          charges: [
            makeCharge({
              id: "mgr-b-charge",
              managerUserId: "mgr-b",
              residentEmail: "b@test.com",
              rentMonth: "2026-04",
              dueDateLabel: "Apr 1, 2026",
            }),
          ],
          rentProfiles: [],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const readCount = () => reads;

    const { syncHouseholdChargesFromServer } = await import("@/lib/household-charges");

    const firstSync = syncHouseholdChargesFromServer(false);
    const forcedSync = syncHouseholdChargesFromServer(true);
    // A SECOND forced caller arriving in the same burst must not add a third
    // request — it joins the one follow-up, which still starts after it asked.
    const secondForcedSync = syncHouseholdChargesFromServer(true);

    // Still one READ in flight: the forced callers are queued behind it rather
    // than each opening their own.
    expect(readCount()).toBe(1);

    resolveFirst!({
      ok: true,
      json: async () => ({ charges: [makeCharge({ id: "mgr-a-charge", managerUserId: "mgr-a" })], rentProfiles: [] }),
    });

    // The forced callers resolve with the SECOND response. That is the
    // invariant: neither may be handed mgr-a, which was already being fetched
    // when they asked.
    await expect(forcedSync).resolves.toEqual(
      expect.objectContaining({
        charges: expect.arrayContaining([expect.objectContaining({ managerUserId: "mgr-b" })]),
      }),
    );
    await expect(secondForcedSync).resolves.toEqual(
      expect.objectContaining({
        charges: expect.arrayContaining([expect.objectContaining({ managerUserId: "mgr-b" })]),
      }),
    );
    // Exactly two reads served three callers.
    expect(readCount()).toBe(2);
    await firstSync;
  });
});

describe("mergeHouseholdChargesWithServer", () => {
  it("keeps local paid status when server still has pending for the same charge id", () => {
    const server = makeCharge({ id: "chg-1", status: "pending" });
    const local = makeCharge({
      id: "chg-1",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
    });

    const { merged, hasUpdated } = mergeHouseholdChargesWithServer([server], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("paid");
    expect(hasUpdated).toBe(true);
  });

  it("keeps local paid status when server pending row uses a different id for the same bill", () => {
    const server = makeCharge({ id: "server-rent-row", status: "pending" });
    const local = makeCharge({
      id: "local-rent-row",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
    });

    const { merged, hasUpdated } = mergeHouseholdChargesWithServer([server], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("paid");
    expect(merged[0]?.id).toBe("local-rent-row");
    expect(hasUpdated).toBe(true);
  });

  it("inherits server paid status when local is still pending", () => {
    const server = makeCharge({
      id: "chg-1",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
    });
    const local = makeCharge({ id: "chg-1", status: "pending" });

    const { merged } = mergeHouseholdChargesWithServer([server], [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("paid");
  });

  it("dedupes duplicate pending/paid rows to a single paid charge", () => {
    const serverPending = makeCharge({ id: "server-row", status: "pending" });
    const serverPaid = makeCharge({
      id: "paid-row",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
    });
    const localPaid = makeCharge({
      id: "local-row",
      status: "paid",
      paidAt: "2026-06-11T12:00:00.000Z",
      balanceLabel: "$0.00",
    });

    const { merged } = mergeHouseholdChargesWithServer([serverPending, serverPaid], [localPaid]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("paid");
  });

  it("dedupes duplicate application-fee rows to one canonical charge id", () => {
    const fallback = makeCharge({
      id: "hc_app_fee_res@test.com_prop1",
      kind: "application_fee",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
      amountLabel: "$50.00",
    });
    const canonical = makeCharge({
      id: "hc_app_fee_app123",
      kind: "application_fee",
      applicationId: "app123",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      status: "paid",
      paidAt: "2026-06-10T12:00:00.000Z",
      balanceLabel: "$0.00",
      amountLabel: "$50.00",
    });

    const merged = dedupeHouseholdCharges([fallback, canonical]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("hc_app_fee_app123");
    expect(duplicateHouseholdChargeIds([fallback, canonical])).toEqual(["hc_app_fee_res@test.com_prop1"]);
  });

  it("dedupes duplicate stay_total rows to one canonical charge id", () => {
    const legacy = makeCharge({
      id: "hc_app_proplane_ms5v4juh_stay_total",
      kind: "stay_total",
      applicationId: "PROPLANE-MS5V4JUH",
      residentEmail: "guest@example.com",
      amountLabel: "$250.00",
      balanceLabel: "$250.00",
      title: "Stay total (5 nights × $50)",
    });
    const canonical = makeCharge({
      id: "hc_app_pl_ms5v4juh_stay_total",
      kind: "stay_total",
      applicationId: "PROPLANE-MS5V4JUH",
      residentEmail: "guest@example.com",
      amountLabel: "$200.00",
      balanceLabel: "$200.00",
      title: "Stay total (4 nights × $50)",
      createdAt: "2026-07-30T00:00:00.000Z",
    });

    const merged = dedupeHouseholdCharges([legacy, canonical]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("hc_app_pl_ms5v4juh_stay_total");
    expect(duplicateHouseholdChargeIds([legacy, canonical])).toEqual(["hc_app_proplane_ms5v4juh_stay_total"]);
  });

  it("dedupes conflicting first-month rent kinds to one upfront slot", () => {
    const fullMonth = makeCharge({
      id: "hc_app_app123_first_month_rent",
      kind: "first_month_rent",
      applicationId: "app123",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      amountLabel: "$825.00",
      balanceLabel: "$825.00",
      title: "First month's rent",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const prorated = makeCharge({
      id: "hc_app_app123_prorated_rent",
      kind: "prorated_rent",
      applicationId: "app123",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      amountLabel: "$870.00",
      balanceLabel: "$870.00",
      title: "Prorated first month's rent (29 days × $30/day)",
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const merged = dedupeHouseholdCharges([fullMonth, prorated]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("prorated_rent");
    expect(merged[0]?.amountLabel).toBe("$870.00");
    expect(duplicateHouseholdChargeIds([fullMonth, prorated])).toEqual(["hc_app_app123_first_month_rent"]);
  });

  it("merges duplicate upfront rent rows from server sync", () => {
    const serverFull = makeCharge({
      id: "hc_app_app123_first_month_rent",
      kind: "first_month_rent",
      applicationId: "app123",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      amountLabel: "$825.00",
      balanceLabel: "$825.00",
      title: "First month's rent",
    });
    const localProrated = makeCharge({
      id: "hc_app_app123_prorated_rent",
      kind: "prorated_rent",
      applicationId: "app123",
      residentEmail: "res@test.com",
      propertyId: "prop-1",
      amountLabel: "$870.00",
      balanceLabel: "$870.00",
      title: "Prorated first month's rent (29 days × $30/day)",
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const { merged } = mergeHouseholdChargesWithServer([serverFull], [localProrated]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("prorated_rent");
  });
});

describe("isManagerAddedOneOffCharge", () => {
  it("recognizes hc_mgr_ ids and legacy work_order_charge without workOrderId", () => {
    expect(isManagerAddedOneOffCharge(makeCharge({ id: "hc_mgr_1_abc", kind: "other_cost" }))).toBe(true);
    expect(
      isManagerAddedOneOffCharge(makeCharge({ id: "legacy-1", kind: "work_order_charge", workOrderId: undefined })),
    ).toBe(true);
    expect(
      isManagerAddedOneOffCharge(makeCharge({ id: "wo-1", kind: "work_order_charge", workOrderId: "wo_123" })),
    ).toBe(false);
    expect(isManagerAddedOneOffCharge(makeCharge({ id: "rent-1", kind: "rent" }))).toBe(false);
  });
});

describe("joinPropertyAndUnitLabel", () => {
  it("joins a property name and unit", () => {
    expect(joinPropertyAndUnitLabel("The Pioneer", "12A")).toBe("The Pioneer · 12A");
  });

  it("does not repeat a unit the label already ends with", () => {
    expect(joinPropertyAndUnitLabel("The Pioneer · 12A", "12A")).toBe("The Pioneer · 12A");
    expect(joinPropertyAndUnitLabel("The Pioneer · 12a", "12A")).toBe("The Pioneer · 12a");
  });

  it("still appends when the tail is a different unit", () => {
    expect(joinPropertyAndUnitLabel("The Pioneer · 11B", "12A")).toBe("The Pioneer · 11B · 12A");
  });

  it("handles a missing side", () => {
    expect(joinPropertyAndUnitLabel("The Pioneer", "")).toBe("The Pioneer");
    expect(joinPropertyAndUnitLabel("", "12A")).toBe("12A");
  });
});
