import { afterEach, describe, expect, it, vi } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";

/**
 * PRP-391 — the charge ledger is manager-owned, and a resident browser holds
 * only the rows it can see. Any write it sends offers the server a partial copy
 * of a collection it does not own; `action:"replace"` would offer to make that
 * partial copy the whole truth.
 *
 * `POST /api/portal-household-charges` answers a resident with 403 and stays the
 * authority. These tests cover the second line of defence the 403 should always
 * have had: the read tells the store who is looking, and a resident session
 * never attempts the write at all.
 */

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

function stubBrowserSession() {
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
}

/** Answers the read with `viewerRole`, and records every non-GET attempt. */
function stubFetchForRole(viewerRole: string) {
  const writes: string[] = [];
  const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      writes.push(method);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ charges: [makeCharge()], rentProfiles: [], viewerRole }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return writes;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resident sessions never write the charge ledger (PRP-391)", () => {
  it("refuses the whole-ledger mirror after a read says the viewer is a resident", async () => {
    vi.resetModules();
    stubBrowserSession();
    const writes = stubFetchForRole("resident");

    const { syncHouseholdChargesFromServer, mirrorHouseholdChargesToServerAwait } = await import(
      "@/lib/household-charges"
    );

    await syncHouseholdChargesFromServer(true, { skipReconcile: true });
    const mirrored = await mirrorHouseholdChargesToServerAwait();

    expect(mirrored).toBe(false);
    expect(writes).toEqual([]);
  });

  it("still writes for a manager, so the guard cannot silently disable the ledger", async () => {
    vi.resetModules();
    stubBrowserSession();
    const writes = stubFetchForRole("manager");

    const { syncHouseholdChargesFromServer, mirrorHouseholdChargesToServerAwait } = await import(
      "@/lib/household-charges"
    );

    await syncHouseholdChargesFromServer(true, { skipReconcile: true });
    const mirrored = await mirrorHouseholdChargesToServerAwait();

    expect(mirrored).toBe(true);
    expect(writes).toEqual(["POST"]);
  });

  it("attempts the write when no read has named the role yet — the server still refuses", async () => {
    vi.resetModules();
    stubBrowserSession();
    const writes = stubFetchForRole("resident");

    const { mirrorHouseholdChargesToServerAwait } = await import("@/lib/household-charges");

    // No sync first: the store has learned nothing, so it must not fail closed
    // and strand a manager whose read has not landed.
    await mirrorHouseholdChargesToServerAwait();

    expect(writes).toEqual(["POST"]);
  });
});
