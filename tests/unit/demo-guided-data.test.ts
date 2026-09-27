import { describe, expect, it, afterEach } from "vitest";
import {
  CANONICAL_DEMO_ADMIN_EMAIL,
  CANONICAL_DEMO_GUIDED_EMAIL,
  CANONICAL_DEMO_MANAGER_EMAIL,
  CANONICAL_DEMO_RESIDENT_EMAIL,
  CANONICAL_DEMO_VENDOR_EMAIL,
} from "@/lib/demo/demo-canonical-accounts";
import {
  buildDemoBlankSnapshot,
  buildDemoIdleSnapshot,
} from "@/lib/demo/demo-guided-data";
import { exitGuidedDemoTour, startGuidedDemoTour } from "@/lib/demo/demo-guided";
import {
  DEMO_GUIDED_EMAIL,
  DEMO_GUIDED_USER_ID,
  DEMO_MANAGER_EMAIL,
  DEMO_RESIDENT_EMAIL,
  DEMO_VENDOR_EMAIL,
  demoSessionForRole,
} from "@/lib/demo/demo-session";

describe("demo-canonical-accounts", () => {
  it("uses @test.proplane.local sandbox emails", () => {
    expect(CANONICAL_DEMO_MANAGER_EMAIL).toBe("manager@test.proplane.local");
    expect(CANONICAL_DEMO_RESIDENT_EMAIL).toBe("resident@test.proplane.local");
    expect(CANONICAL_DEMO_VENDOR_EMAIL).toBe("vendor@test.proplane.local");
    expect(CANONICAL_DEMO_ADMIN_EMAIL).toBe("testeverything@test.proplane.local");
    expect(CANONICAL_DEMO_GUIDED_EMAIL).toBe(CANONICAL_DEMO_ADMIN_EMAIL);
  });

  it("demo session re-exports canonical emails", () => {
    expect(DEMO_MANAGER_EMAIL).toBe(CANONICAL_DEMO_MANAGER_EMAIL);
    expect(DEMO_RESIDENT_EMAIL).toBe(CANONICAL_DEMO_RESIDENT_EMAIL);
    expect(DEMO_VENDOR_EMAIL).toBe(CANONICAL_DEMO_VENDOR_EMAIL);
  });
});

describe("demo-guided session", () => {
  afterEach(() => {
    exitGuidedDemoTour();
  });

  it("guided tour uses the everything test account", () => {
    startGuidedDemoTour();
    const session = demoSessionForRole("manager");
    expect(session.userId).toBe(DEMO_GUIDED_USER_ID);
    expect(session.email).toBe(DEMO_GUIDED_EMAIL);
  });
});

describe("demo-guided-data snapshots", () => {
  it("idle snapshot carries the Seattle Homes portfolio (captain 2026-09-25)", () => {
    const snapshot = buildDemoIdleSnapshot();
    expect(snapshot.properties.map((p) => p.title).sort()).toEqual([
      "Alder House",
      "Fremont Studio",
      "Maple Duplex",
    ]);
    expect(snapshot.applications.length).toBeGreaterThan(0);
    expect(snapshot.charges.length).toBeGreaterThan(0);
    expect(snapshot.leases.length).toBeGreaterThan(0);
    // The busy portfolio (captain 2026-09-25) seeds real work orders and a
    // manager inbox thread too.
    expect(snapshot.workOrders.length).toBeGreaterThan(0);
    expect(snapshot.managerInbox.length).toBeGreaterThan(0);
    // Buckets the portfolio deliberately leaves untouched stay empty.
    expect(snapshot.residentInbox).toEqual([]);
    expect(snapshot.vendorInbox).toEqual([]);
    expect(snapshot.residentUploads).toEqual([]);
  });

  it("blank snapshot stays a genuinely empty slate for the guided tour", () => {
    const snapshot = buildDemoBlankSnapshot();
    expect(snapshot.properties).toEqual([]);
    expect(snapshot.applications).toEqual([]);
    expect(snapshot.workOrders).toEqual([]);
    expect(snapshot.managerInbox).toEqual([]);
  });

  it("idle and blank snapshots are independent objects", () => {
    const a = buildDemoIdleSnapshot();
    const b = buildDemoIdleSnapshot();
    const before = b.properties.length;
    a.properties.push({ id: "x" } as (typeof a.properties)[number]);
    // Mutating one call's array never leaks into a separate call's array.
    expect(b.properties.length).toBe(before);
    expect(buildDemoBlankSnapshot().properties).toEqual([]);
  });
});
