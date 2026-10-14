import { describe, expect, it } from "vitest";
import { applicationRowCanQuickBook, quickBookPrefillForApplication } from "@/lib/channel-calendar/quick-book";
import type { DemoApplicantRow } from "@/data/demo-portal";

function row(over: Record<string, unknown> = {}, app: Record<string, unknown> = {}): DemoApplicantRow {
  return {
    id: "AXIS-123",
    name: "Maya Zuneh",
    email: "maya@example.com",
    bucket: "pending",
    stage: "Submitted",
    application: { roomChoice1: "h1::r2", leaseStart: "2026-11-01", leaseEnd: "2026-12-01", phone: "555-0100", ...app },
    ...over,
  } as unknown as DemoApplicantRow;
}

describe("Quick book row action", () => {
  it("is offered for approved only, not pending or rejected", () => {
    expect(applicationRowCanQuickBook(row())).toBe(false);
    expect(applicationRowCanQuickBook(row({ bucket: "approved" }))).toBe(true);
    expect(applicationRowCanQuickBook(row({ bucket: "rejected" }))).toBe(false);
  });

  it("is never offered for a withdrawn or an unfinished application, both of which stay pending", () => {
    expect(applicationRowCanQuickBook(row({ withdrawnAt: "2026-10-02T00:00:00.000Z" }))).toBe(false);
    expect(applicationRowCanQuickBook(row({ stage: "In progress" }))).toBe(false);
    expect(applicationRowCanQuickBook(row({ stage: "" }, { propertyId: "h1" }))).toBe(false);
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
