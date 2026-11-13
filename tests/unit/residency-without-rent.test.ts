import { describe, expect, it } from "vitest";
import { leasesWithoutRentCharges } from "@/lib/residency-without-rent";
import { buildManagerAttentionRows } from "@/lib/manager-attention-queue";

const NOW = new Date("2026-11-12T12:00:00Z");
const lease = (over = {}) => ({
  id: "l1", status: "Fully Signed", residentEmail: "Room7@x.com", propertyId: "p4709a",
  fullySignedAt: "2026-10-20T00:00:00Z", voidedAt: null, ...over,
});

describe("a signed lease nobody is billing is an owner alert", () => {
  it("flags an executed lease with no rent charge of any kind", () => {
    expect(leasesWithoutRentCharges({ leases: [lease()], charges: [], now: NOW })).toEqual(["l1"]);
    // A deposit or fee is not rent: the schedule still never ran.
    expect(leasesWithoutRentCharges({ leases: [lease()], charges: [{ residentEmail: "room7@x.com", propertyId: "p4709a", kind: "security_deposit" }], now: NOW })).toEqual(["l1"]);
  });

  it("any rent charge, in any status, proves billing happened (email is case-insensitive)", () => {
    for (const kind of ["rent", "first_month_rent", "prorated_rent"]) {
      expect(leasesWithoutRentCharges({ leases: [lease()], charges: [{ residentEmail: "ROOM7@x.com", propertyId: "p4709a", kind }], now: NOW })).toEqual([]);
    }
  });

  it("a rent charge on another house or for another resident does not cover this lease", () => {
    expect(leasesWithoutRentCharges({ leases: [lease()], charges: [{ residentEmail: "room7@x.com", propertyId: "other", kind: "rent" }], now: NOW })).toEqual(["l1"]);
    expect(leasesWithoutRentCharges({ leases: [lease()], charges: [{ residentEmail: "x@x.com", propertyId: "p4709a", kind: "rent" }], now: NOW })).toEqual(["l1"]);
  });

  it("says nothing for a lease that is not executed, is voided, was signed inside the grace period, or has no signing time", () => {
    for (const over of [{ status: "Manager Signature Pending" }, { voidedAt: "2026-11-01T00:00:00Z" }, { fullySignedAt: "2026-11-11T00:00:00Z" }, { fullySignedAt: null }, { residentEmail: "" }]) {
      expect(leasesWithoutRentCharges({ leases: [lease(over)], charges: [], now: NOW })).toEqual([]);
    }
  });

  it("surfaces as a danger row in the Needs-attention queue, and not at all when zero", () => {
    const base = {
      basePath: "/portal", overdueChargeCount: 0, overdueBalanceLabel: "$0", pendingApplicationCount: 0, managerSignatureLeaseCount: 0,
      pendingTourCount: 0, messagingNeedsSetup: false, messagingSettingsHref: "/x", draftPropertyCount: 0, draftsHref: "/d", unreadConversationCount: 0,
    };
    const rows = buildManagerAttentionRows({ ...base, unbilledResidencyCount: 2 });
    expect(rows[0]).toMatchObject({ id: "unbilled-residency", title: "2 signed leases have no rent charged", tone: "danger" });
    expect(buildManagerAttentionRows({ ...base, unbilledResidencyCount: 1 })[0]!.title).toBe("1 signed lease has no rent charged");
    expect(buildManagerAttentionRows(base).some((r) => r.id === "unbilled-residency")).toBe(false);
  });
});
