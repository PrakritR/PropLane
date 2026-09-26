import { describe, expect, it } from "vitest";
import { buildDemoIdleSnapshot, type DemoDataSnapshot } from "@/lib/demo/demo-guided-data";
import {
  DEMO_CANONICAL_RESIDENT_APP_DEMO_ID,
  DEMO_CANONICAL_RESIDENT_CHARGE_APP_REF,
  remapDemoSnapshotForDb,
} from "@/lib/demo/demo-portfolio-db-remap";
import { CANONICAL_DEMO_RESIDENT_EMAIL, CANONICAL_DEMO_VENDOR_EMAIL } from "@/lib/demo/demo-canonical-accounts";
import {
  DEMO_MANAGER_USER_ID,
  DEMO_RESIDENT_USER_ID,
  DEMO_VENDOR_USER_ID,
} from "@/lib/demo/demo-session";

const ctx = {
  managerUserId: "mgr-uuid-1111",
  residentUserId: "res-uuid-2222",
  vendorUserId: "ven-uuid-3333",
  residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
  vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
  residentAxisId: "AXIS-TESTRSID",
};

/**
 * `buildDemoIdleSnapshot()` now ships the real Seattle Homes portfolio
 * (captain 2026-09-25), but the remap rules below are still exercised against
 * a small hand-built fixture with the exact synthetic demo scope ids the
 * seeder has to rewrite, for a tighter, easier-to-read assertion surface.
 */
function fixtureSnapshot(): DemoDataSnapshot {
  const base = buildDemoIdleSnapshot();
  return {
    ...base,
    properties: [
      {
        id: "mgr-fixture-1",
        title: "Fixture House",
        address: "1 Fixture St",
        zip: "98101",
        neighborhood: "Fixture",
        beds: 2,
        baths: 1,
        rentLabel: "$2,000/mo",
        available: "Now",
        managerUserId: DEMO_MANAGER_USER_ID,
      },
    ],
    applications: [
      {
        id: DEMO_CANONICAL_RESIDENT_APP_DEMO_ID,
        name: "Fixture Resident",
        email: CANONICAL_DEMO_RESIDENT_EMAIL,
        property: "Fixture House",
        propertyId: "mgr-fixture-1",
        assignedPropertyId: "mgr-fixture-1",
        stage: "Approved",
        bucket: "approved",
        detail: "",
        managerUserId: DEMO_MANAGER_USER_ID,
      },
    ],
    charges: [
      {
        id: "fixture-charge-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
        residentName: "Fixture Resident",
        residentUserId: DEMO_RESIDENT_USER_ID,
        propertyId: "mgr-fixture-1",
        propertyLabel: "Fixture House",
        managerUserId: DEMO_MANAGER_USER_ID,
        kind: "first_month_rent",
        title: "First month rent",
        amountLabel: "$2,000.00",
        balanceLabel: "$2,000.00",
        status: "pending",
        blocksLeaseUntilPaid: false,
        applicationId: DEMO_CANONICAL_RESIDENT_CHARGE_APP_REF,
      },
    ],
    vendors: [
      {
        id: "demo-vendor-1",
        name: "Fixture Vendor",
        email: "stale@example.com",
        phone: "",
        trade: "HVAC",
        notes: "",
        active: true,
        managerUserId: DEMO_MANAGER_USER_ID,
        vendorUserId: DEMO_VENDOR_USER_ID,
      },
    ],
    workOrderBids: [
      {
        id: "fixture-bid-1",
        workOrderId: "fixture-wo-1",
        vendorUserId: DEMO_VENDOR_USER_ID,
        vendorDirectoryId: "demo-vendor-1",
        quoteMode: "upfront",
        consultationVisitAt: null,
        amountCents: 10_000,
        materialsCents: 0,
        proposedTime: "2026-08-01T12:00:00.000Z",
        note: null,
        status: "submitted",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  } as DemoDataSnapshot;
}

describe("remapDemoSnapshotForDb", () => {
  it("rewrites synthetic demo scope ids to real auth UUIDs", () => {
    const snapshot = remapDemoSnapshotForDb(fixtureSnapshot(), ctx);
    expect(snapshot.properties.every((p) => p.managerUserId === ctx.managerUserId)).toBe(true);
    expect(snapshot.applications.every((a) => a.managerUserId === ctx.managerUserId)).toBe(true);
    const residentApp = snapshot.applications.find((a) => a.email === ctx.residentEmail);
    expect(residentApp?.id).toBe(ctx.residentAxisId);
    expect(snapshot.charges.some((c) => c.applicationId === ctx.residentAxisId)).toBe(true);
    expect(
      snapshot.charges
        .filter((c) => c.residentEmail === ctx.residentEmail)
        .every((c) => c.residentUserId === ctx.residentUserId),
    ).toBe(true);
    const primaryVendor = snapshot.vendors.find((v) => v.id === "demo-vendor-1");
    expect(primaryVendor?.vendorUserId).toBe(ctx.vendorUserId);
    expect(primaryVendor?.email).toBe(ctx.vendorEmail);
    expect(snapshot.workOrderBids.every((b) => b.vendorUserId === ctx.vendorUserId)).toBe(true);
  });

  it("maps canonical resident application refs from demo ids", () => {
    const fixture = fixtureSnapshot();
    expect(fixture.applications.some((a) => a.id === DEMO_CANONICAL_RESIDENT_APP_DEMO_ID)).toBe(true);
    expect(fixture.charges.some((c) => c.applicationId === DEMO_CANONICAL_RESIDENT_CHARGE_APP_REF)).toBe(true);
    const snapshot = remapDemoSnapshotForDb(fixture, ctx);
    expect(snapshot.applications.some((a) => a.id === DEMO_CANONICAL_RESIDENT_APP_DEMO_ID)).toBe(false);
    expect(snapshot.applications.some((a) => a.id === ctx.residentAxisId)).toBe(true);
    expect(snapshot.charges.some((c) => c.applicationId === DEMO_CANONICAL_RESIDENT_CHARGE_APP_REF)).toBe(false);
    expect(snapshot.charges.some((c) => c.applicationId === ctx.residentAxisId)).toBe(true);
  });

  it("does not leak demo session ids on manager-scoped rows", () => {
    const snapshot = remapDemoSnapshotForDb(fixtureSnapshot(), ctx);
    const json = JSON.stringify(snapshot);
    expect(json.includes(`"${DEMO_MANAGER_USER_ID}"`)).toBe(false);
    expect(json.includes(`"${DEMO_RESIDENT_USER_ID}"`)).toBe(false);
    expect(json.includes(`"${DEMO_VENDOR_USER_ID}"`)).toBe(false);
  });

  it("passes the shipped Seattle Homes idle snapshot through without error", () => {
    const snapshot = remapDemoSnapshotForDb(buildDemoIdleSnapshot(), ctx);
    expect(snapshot.properties.length).toBeGreaterThan(0);
    expect(snapshot.applications.length).toBeGreaterThan(0);
    expect(snapshot.charges.length).toBeGreaterThan(0);
    // Remapped onto the ctx ids passed in above, not the synthetic demo ones.
    for (const property of snapshot.properties) {
      expect(property.managerUserId).toBe(ctx.managerUserId);
    }
  });
});
