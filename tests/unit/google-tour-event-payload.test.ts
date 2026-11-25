import { describe, expect, it } from "vitest";

import { tourEventDeepLink, tourEventDescription, tourEventFactsFromRecord, tourEventSummary } from "@/lib/google-calendar/tour-event-payload";
import { PROPLANE_GOOGLE_CALENDAR_MARKER, PROPLANE_TOUR_TYPE_MARKER } from "@/lib/google-calendar/markers";
import { tourRowsFromPlannedEvents } from "@/lib/manager-tour-list";
import { managerTourDetailHref } from "@/lib/portal-detail-routes";
import type { PlannedEvent } from "@/lib/demo-admin-scheduling";

const plannedEvent: PlannedEvent = {
  id: "evt 1",
  title: "Tour · Ana Ruiz",
  start: "2099-03-01T22:00:00.000Z",
  end: "2099-03-01T22:30:00.000Z",
  kind: "tour",
  propertyTitle: "5257 Brooklyn Ave",
  roomLabel: "Room 6",
  attendeeName: "Ana Ruiz",
};

/**
 * Oracle: the Tours list itself. `tourRowsFromPlannedEvents` mints the row id and bucket the detail view resolves by,
 * so the link is right only when it equals that row's own detail route. Rejects the raw planned-event id.
 */
const listRow = tourRowsFromPlannedEvents([plannedEvent])[0]!;
const listRowHref = `https://proplane.ai${managerTourDetailHref("/portal", listRow.bucket, listRow.id)}`;

const facts = {
  plannedEventId: plannedEvent.id,
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
    expect(body).toContain(`Open in PropLane: ${listRowHref}`);
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

  it("deep-links the row id the Tours list gives the planned tour, not the raw event id", () => {
    expect(listRow.bucket).toBe("upcoming");
    expect(tourEventDeepLink("https://proplane.ai", plannedEvent.id)).toBe(listRowHref);
    expect(tourEventDeepLink("https://proplane.ai", plannedEvent.id)).not.toContain("/upcoming/evt%201");
  });

  it("reads room and format off a stored planned-event record", () => {
    expect(tourEventFactsFromRecord({ roomLabel: " Room 2 ", tourFormat: "virtual" })).toEqual({ roomLabel: "Room 2", tourFormat: "virtual" });
    expect(tourEventFactsFromRecord(null)).toEqual({ roomLabel: undefined, tourFormat: undefined });
  });
});
