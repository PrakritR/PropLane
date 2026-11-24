import { describe, expect, it } from "vitest";

import { tourEventDeepLink, tourEventDescription, tourEventFactsFromRecord, tourEventSummary } from "@/lib/google-calendar/tour-event-payload";
import { PROPLANE_GOOGLE_CALENDAR_MARKER, PROPLANE_TOUR_TYPE_MARKER } from "@/lib/google-calendar/markers";

const facts = {
  plannedEventId: "evt 1",
  title: "Tour · Ana Ruiz",
  propertyTitle: "5257 Brooklyn Ave",
  roomLabel: "Room 6",
  tourFormat: "in_person",
  attendeeName: "Ana Ruiz",
  attendeeEmail: "ana@example.com",
  attendeePhone: "+12065550100",
};

describe("tour event payload", () => {
  it("names the prospect, property, room, format and a deep link that opens the tour", () => {
    const body = tourEventDescription(facts, "https://proplane.ai/");
    expect(body).toContain(PROPLANE_TOUR_TYPE_MARKER);
    expect(body).toContain(PROPLANE_GOOGLE_CALENDAR_MARKER);
    expect(body).toContain("Guest: Ana Ruiz");
    expect(body).toContain("Property: 5257 Brooklyn Ave");
    expect(body).toContain("Room: Room 6");
    expect(body).toContain("Format: In person");
    expect(body).toContain("Open in PropLane: https://proplane.ai/portal/tours/upcoming/evt%201");
  });

  it("marks a virtual tour in the body and the title", () => {
    expect(tourEventDescription({ ...facts, tourFormat: "virtual" }, "https://proplane.ai")).toContain("Format: Virtual");
    expect(tourEventSummary({ ...facts, tourFormat: "virtual" })).toBe("Tour · Ana Ruiz · Room 6 (virtual)");
    expect(tourEventSummary(facts)).toBe("Tour · Ana Ruiz · Room 6");
  });

  it("treats a missing or unknown format as in person and leaves absent facts out", () => {
    const body = tourEventDescription({ plannedEventId: "e", title: "Tour", tourFormat: "weird" }, "https://x.test");
    expect(body).toContain("Format: In person");
    expect(body).not.toContain("Room:");
    expect(body).not.toContain("Email:");
  });

  it("uses the same detail route builder as the portal and reads room/format off a stored record", () => {
    expect(tourEventDeepLink("https://proplane.ai", "abc")).toBe("https://proplane.ai/portal/tours/upcoming/abc");
    expect(tourEventFactsFromRecord({ roomLabel: " Room 2 ", tourFormat: "virtual" })).toEqual({ roomLabel: "Room 2", tourFormat: "virtual" });
    expect(tourEventFactsFromRecord(null)).toEqual({ roomLabel: undefined, tourFormat: undefined });
  });
});
