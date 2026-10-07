import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  PUBLIC_BOARD_SERVICE_FIELDS,
  PUBLIC_SERVICE_FIELDS,
  PUBLIC_SERVICE_SOURCE_KEYS,
  publicBoardServiceProjection,
  publicServiceProjection,
} from "@/lib/public-service-projection";

/** A stored service carrying everything a stranger must never see, each value a unique sentinel. */
function privateService(): DemoManagerWorkOrderRow {
  return {
    id: "wo-SECRET-ID-123",
    reference: "WO-SECRET-REF",
    propertyName: "1420 Alder St, Seattle, WA",
    unit: "Unit SECRET-UNIT-9",
    title: "Kitchen sink leak",
    priority: "Emergency",
    status: "Open",
    bucket: "pending" as DemoManagerWorkOrderRow["bucket"],
    description: "Slow leak under the kitchen sink.",
    scheduled: "—",
    cost: "$SECRET-COST",
    preferredArrival: "weekdays after 5pm",
    entryPermission: "allowed",
    entryNotes: "SECRET-ENTRY-lockbox-4821",
    propertyAddress: "1420 Alder St, Green Lake, Seattle, WA 98115",
    residentName: "SECRET-RESIDENT-NAME",
    residentEmail: "secret-resident@example.com",
    propertyId: "prop-SECRET",
    assignedPropertyId: "prop-SECRET-2",
    managerUserId: "mgr-SECRET-USER",
    managerName: "SECRET-MANAGER-NAME-FIELD",
    photoDataUrls: ["https://cdn.example/one.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd"],
    vendorId: undefined,
    vendorCostCents: 99999,
    materialsCostCents: 88888,
    residentChargeCents: 77777,
    residentChargeId: "charge-SECRET",
    category: "plumbing",
    publishRef: "pub_" + "a".repeat(32),
    publishBudgetCents: 25000,
    publishSharePhotos: false,
    published: true,
  } as DemoManagerWorkOrderRow;
}

describe("publicServiceProjection (allowlist)", () => {
  it("emits exactly the allowlisted keys and nothing else", () => {
    const view = publicServiceProjection(privateService(), "Alder Property Co");
    expect(Object.keys(view).sort()).toEqual([...PUBLIC_SERVICE_FIELDS].sort());
    const board = publicBoardServiceProjection(privateService(), "Alder Property Co");
    expect(Object.keys(board ?? {}).sort()).toEqual([...PUBLIC_BOARD_SERVICE_FIELDS].sort());
  });

  it("never leaks the address, unit, resident, entry notes, cost, manager id or work order id", () => {
    const wire = JSON.stringify([
      publicServiceProjection({ ...privateService(), publishSharePhotos: true }, "Alder Property Co"),
      publicBoardServiceProjection(privateService(), "Alder Property Co"),
    ]);
    for (const secret of [
      "1420",
      "Alder St",
      "98115",
      "SECRET-UNIT",
      "SECRET-RESIDENT-NAME",
      "secret-resident@example.com",
      "SECRET-ENTRY",
      "lockbox",
      "SECRET-COST",
      "SECRET-ID",
      "SECRET-REF",
      "mgr-SECRET",
      "SECRET-MANAGER-NAME-FIELD",
      "prop-SECRET",
      "charge-SECRET",
      "99999",
      "88888",
      "77777",
    ]) {
      expect(wire, secret).not.toContain(secret);
    }
  });

  it("gives the general area (city) and the trade, budget, when and poster", () => {
    const view = publicServiceProjection(privateService(), "Alder Property Co");
    expect(view).toMatchObject({
      title: "Kitchen sink leak",
      trade: "Plumbing",
      area: "Seattle",
      when: "weekdays after 5pm",
      budget: "Up to $250",
      postedBy: "Alder Property Co",
    });
  });

  it("falls back to Nearby, never the street, when only an address-shaped name exists", () => {
    const row = { ...privateService(), propertyAddress: undefined, propertyName: "1420 Alder St" };
    expect(publicServiceProjection(row, "").area).toBe("Nearby");
  });

  it("shows photos only when Share photos is on, and only https / inline image sources", () => {
    expect(publicServiceProjection(privateService(), "").photos).toEqual([]);
    const shared = publicServiceProjection({ ...privateService(), publishSharePhotos: true }, "");
    expect(shared.photos).toEqual(["https://cdn.example/one.jpg", "data:image/png;base64,AAAA"]);
  });

  it("a field added to the row tomorrow is private until it is allowlisted", () => {
    const row = { ...privateService(), brandNewPrivateField: "SECRET-NEW" } as DemoManagerWorkOrderRow;
    expect(JSON.stringify(publicServiceProjection(row, ""))).not.toContain("SECRET-NEW");
  });

  it("reads only the keys it names (the allowlist is the type-checked source list)", () => {
    expect([...PUBLIC_SERVICE_SOURCE_KEYS]).not.toContain("residentEmail");
    expect([...PUBLIC_SERVICE_SOURCE_KEYS]).not.toContain("entryNotes");
    expect([...PUBLIC_SERVICE_SOURCE_KEYS]).not.toContain("cost");
    expect([...PUBLIC_SERVICE_SOURCE_KEYS]).not.toContain("id");
  });

  it("the board entry carries the opaque ref and nothing resembling the work order id", () => {
    const board = publicBoardServiceProjection(privateService(), "Alder Property Co")!;
    expect(board.ref).toBe("pub_" + "a".repeat(32));
    expect(JSON.stringify(board)).not.toContain("wo-SECRET");
    expect(publicBoardServiceProjection({ ...privateService(), publishRef: undefined }, "x")).toBeNull();
  });
});
