import { describe, expect, it } from "vitest";
import { applicationRowCanQuickBook, quickBookPrefillForApplication } from "@/lib/channel-calendar/quick-book";
import type { DemoApplicantRow } from "@/data/demo-portal";

function row(over: Record<string, unknown> = {}, app: Record<string, unknown> = {}): DemoApplicantRow {
  return {
    id: "AXIS-123",
    name: "Maya Zuneh",
    email: "maya@example.com",
    bucket: "pending",
    application: { roomChoice1: "h1::r2", leaseStart: "2026-11-01", leaseEnd: "2026-12-01", phone: "555-0100", ...app },
    ...over,
  } as unknown as DemoApplicantRow;
}

describe("Quick book row action", () => {
  it("is offered for pending and approved, not rejected", () => {
    expect(applicationRowCanQuickBook({ bucket: "pending" })).toBe(true);
    expect(applicationRowCanQuickBook({ bucket: "approved" })).toBe(true);
    expect(applicationRowCanQuickBook({ bucket: "rejected" })).toBe(false);
  });

  it("prefills property, room, dates and resident from the application", () => {
    expect(quickBookPrefillForApplication(row())).toEqual({
      propertyId: "h1",
      roomId: "r2",
      checkIn: "2026-11-01",
      checkOut: "2026-12-01",
      resident: { name: "Maya Zuneh", email: "maya@example.com", phone: "555-0100" },
      reason: "Application AXIS-123",
    });
  });

  it("checks out the next day when there is no lease end", () => {
    expect(quickBookPrefillForApplication(row({}, { leaseEnd: "" }))?.checkOut).toBe("2026-11-02");
  });

  it("has nothing to hold without a room or move-in date", () => {
    expect(quickBookPrefillForApplication(row({}, { roomChoice1: "" }))).toBeNull();
    expect(quickBookPrefillForApplication(row({}, { leaseStart: "" }))).toBeNull();
  });
});
