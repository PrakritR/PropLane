/**
 * @vitest-environment jsdom
 *
 * Two defects a landlord hit on a live account, reported as:
 *   "Fekadu rent is $1100 when I change and save it does not update"
 *   "Also wrong house and room for him"
 *
 * 1. Editing a charge amount reported "Payment updated." off the BROWSER write and
 *    returned before the server had answered, so a refused save looked successful and
 *    then quietly reverted. And even a save the server accepted was undone moments
 *    later, because regenerating a resident's billing rebuilds pending rent from the
 *    listing's terms — throwing away the figure the manager had just typed.
 *
 * 2. Every manager payments row hardcoded `roomNumber: "—"`, so a resident's room was
 *    never shown; the property label carried the house's ROOM COUNT instead, which is
 *    how one resident's row came to read "4709A 8th Ave NE · 10 rooms".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagerCharge,
  householdChargeToLedgerRow,
  readHouseholdCharges,
  updateHouseholdChargeAmount,
  upsertRecurringRentProfile,
} from "@/lib/household-charges";
import type { HouseholdCharge } from "@/lib/household-charges";

const MANAGER = "mgr-1";

function seedCharge(): HouseholdCharge {
  const charge = createManagerCharge({
    residentEmail: "fekadu@example.com",
    residentName: "Fekadu Bizuneh",
    propertyId: "prop-1",
    propertyLabel: "4709A 8th Ave NE",
    managerUserId: MANAGER,
    title: "Monthly rent",
    amount: 1000,
  });
  if (!charge) throw new Error("seed charge failed");
  return charge;
}

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true } as Response);
}
function refusingFetch() {
  return vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  // jsdom lands on "/", which the app reads as the public demo surface — and a demo
  // session deliberately never writes to the server. Stand on a portal path so these
  // tests exercise the real server round trip.
  window.history.replaceState({}, "", "/portal/payments");
});

describe("editing a payment amount reports what the SERVER did", () => {
  it("confirms only after the server accepts the write", async () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();

    const handle = updateHouseholdChargeAmount(charge.id, 1100, MANAGER);
    expect(handle).not.toBeNull();

    // The browser shows the new figure straight away…
    expect(readHouseholdCharges().find((c) => c.id === charge.id)?.amountLabel).toBe("$1100.00");
    // …but "saved" is only claimed once the server has actually answered.
    await expect(handle!.confirmed).resolves.toBe("saved");
    expect(readHouseholdCharges().find((c) => c.id === charge.id)?.amountLabel).toBe("$1100.00");
  });

  it("rolls the amount back and reports failure when the server refuses", async () => {
    vi.stubGlobal("fetch", refusingFetch());
    const charge = seedCharge();

    const handle = updateHouseholdChargeAmount(charge.id, 1100, MANAGER);
    expect(handle).not.toBeNull();
    await expect(handle!.confirmed).resolves.toBe("failed");

    // This is the defect: the manager used to be told "Payment updated." and the
    // browser kept $1,100 until a later read silently put $1,000 back.
    expect(readHouseholdCharges().find((c) => c.id === charge.id)?.amountLabel).toBe("$1000.00");
  });

  it("reports failure rather than resolving when the network throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const charge = seedCharge();

    const handle = updateHouseholdChargeAmount(charge.id, 1100, MANAGER);
    await expect(handle!.confirmed).resolves.toBe("failed");
    expect(readHouseholdCharges().find((c) => c.id === charge.id)?.amountLabel).toBe("$1000.00");
  });

  it("returns null — never a silent success — for a charge this manager cannot see", () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();
    expect(updateHouseholdChargeAmount(charge.id, 1100, "another-manager")).toBeNull();
    expect(updateHouseholdChargeAmount("no-such-charge", 1100, MANAGER)).toBeNull();
  });

  it("marks the edit as the manager's own so regeneration cannot overwrite it", async () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();
    const handle = updateHouseholdChargeAmount(charge.id, 1100, MANAGER);
    await handle!.confirmed;

    const saved = readHouseholdCharges().find((c) => c.id === charge.id);
    expect(saved?.manualAmountOverrideAt).toBeTruthy();
  });

  it("rejects an invalid amount without touching the stored charge", () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();
    expect(updateHouseholdChargeAmount(charge.id, Number.NaN, MANAGER)).toBeNull();
    expect(updateHouseholdChargeAmount(charge.id, -5, MANAGER)).toBeNull();
    expect(readHouseholdCharges().find((c) => c.id === charge.id)?.amountLabel).toBe("$1000.00");
  });
});

describe("a payments row names the resident's room, not the house's room count", () => {
  it("shows the assigned room from the resident's rent profile", () => {
    vi.stubGlobal("fetch", okFetch());
    upsertRecurringRentProfile({
      residentEmail: "fekadu@example.com",
      residentName: "Fekadu Bizuneh",
      propertyId: "prop-1",
      propertyLabel: "4709A 8th Ave NE",
      roomLabel: "Room 5",
      managerUserId: MANAGER,
      monthlyRent: 1100,
    });
    const charge = seedCharge();

    const row = householdChargeToLedgerRow({ ...charge, residentEmail: "fekadu@example.com" });
    expect(row.roomNumber).toBe("Room 5");
  });

  it("strips a room count off the property label", () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();

    const row = householdChargeToLedgerRow({
      ...charge,
      propertyLabel: "4709A 8th Ave NE · 10 rooms",
    });
    expect(row.propertyName).toBe("4709A 8th Ave NE");
  });

  it("leaves an ordinary address alone", () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();
    const row = householdChargeToLedgerRow({ ...charge, propertyLabel: "2333 E Southern Ave # 2066" });
    expect(row.propertyName).toBe("2333 E Southern Ave # 2066");
  });

  it("falls back to a dash rather than inventing a room", () => {
    vi.stubGlobal("fetch", okFetch());
    const charge = seedCharge();
    const row = householdChargeToLedgerRow({ ...charge, residentEmail: "nobody@example.com" });
    expect(row.roomNumber).toBe("—");
  });
});
