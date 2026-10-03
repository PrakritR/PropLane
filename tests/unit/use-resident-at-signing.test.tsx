// @vitest-environment jsdom
//
// MONEY (client half of the gate): Sign stays off from the first render, turns on only when the SERVER's
// charge records say every at-signing line is paid (the Stripe webhook wrote that, not the page), and the
// waiver / offline-collection cases never trap the resident.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";
import { HOUSEHOLD_CHARGES_SESSION_KEY } from "@/lib/household-charges";
import { useResidentAtSigning } from "@/hooks/use-resident-at-signing";

const EMAIL = "signer@example.com";
const lease = { axisId: "AXIS-APP-1", residentEmail: EMAIL, propertyId: "prop-1" };

function line(id: string, kind: HouseholdCharge["kind"], amount: string, over: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id,
    createdAt: "2026-10-03T00:00:00.000Z",
    applicationId: "AXIS-APP-1",
    residentEmail: EMAIL,
    residentName: "Signer",
    residentUserId: "u1",
    propertyId: "prop-1",
    propertyLabel: "Cascade Lofts",
    managerUserId: "m1",
    kind,
    title: kind,
    amountLabel: amount,
    balanceLabel: amount,
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueAtSigning: true,
    axisPaymentsEnabledSnapshot: true,
    managerStripeConnectReadySnapshot: true,
    ...over,
  };
}

let serverCharges: HouseholdCharge[] = [];

beforeEach(() => {
  // A real resident page, not the public demo surface (which never reads the server).
  window.history.pushState({}, "", "/resident/lease");
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ charges: serverCharges, rentProfiles: [], viewerRole: "resident" }),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useResidentAtSigning", () => {
  it("blocks signing until the server has been read, and while any line is unpaid", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00"), line("b", "security_deposit", "$500.00")];
    const { result } = renderHook(() => useResidentAtSigning(lease, EMAIL, "u1"));
    expect(result.current.blocked).toBe(true); // before the first read
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.blocked).toBe(true);
    expect(result.current.charges.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(result.current.totalCents).toBe(80_000);
  });

  it("unlocks only after the webhook has marked every line paid", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00"), line("b", "security_deposit", "$500.00")];
    const { result } = renderHook(() => useResidentAtSigning(lease, EMAIL, "u1"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.blocked).toBe(true);

    // The resident finished the Stripe form, but the webhook has not landed: still blocked.
    serverCharges = [line("a", "lease_fee", "$300.00", { status: "paid", balanceLabel: "$0.00" }), line("b", "security_deposit", "$500.00")];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.blocked).toBe(true);
    expect(result.current.totalCents).toBe(50_000);

    // The webhook lands.
    serverCharges = serverCharges.map((c) => ({ ...c, status: "paid" as const, balanceLabel: "$0.00" }));
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(result.current.charges).toEqual([]);
    expect(result.current.totalCents).toBe(0);
  });

  it("waitForSettled resolves true once the server shows everything paid", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00")];
    const { result } = renderHook(() => useResidentAtSigning(lease, EMAIL, "u1"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    serverCharges = [line("a", "lease_fee", "$300.00", { status: "paid", balanceLabel: "$0.00" })];
    let settled = false;
    await act(async () => {
      settled = await result.current.waitForSettled();
    });
    expect(settled).toBe(true);
  });

  it("a waived (cancelled) lease fee is neither charged nor blocking", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00", { status: "cancelled", waivedAt: "2026-10-03T00:00:00.000Z" })];
    const { result } = renderHook(() => useResidentAtSigning(lease, EMAIL, "u1"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.blocked).toBe(false);
    expect(result.current.totalCents).toBe(0);
  });

  it("a line the manager collects offline does not trap the resident", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00", { axisPaymentsEnabledSnapshot: false })];
    const { result } = renderHook(() => useResidentAtSigning(lease, EMAIL, "u1"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.blocked).toBe(false);
  });

  it("gates nothing when there is no lease awaiting a signature", async () => {
    serverCharges = [line("a", "lease_fee", "$300.00")];
    const { result } = renderHook(() => useResidentAtSigning(null, EMAIL, "u1"));
    expect(result.current.blocked).toBe(false);
    expect(result.current.ready).toBe(true);
  });
});
