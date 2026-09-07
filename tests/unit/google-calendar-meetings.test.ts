import { describe, expect, it } from "vitest";
import {
  googleCalendarEventsToMeetings,
  isGoogleCalendarPrivateBlock,
  isGoogleCalendarTourEvent,
  isGoogleCalendarWorkOrderEvent,
  meetingCalendarGridLabel,
  parseProplaneGoogleCalendarDescription,
} from "@/lib/google-calendar/meetings";
import {
  googleCalendarApiEventFromListItem,
  type GoogleCalendarApiEvent,
} from "@/lib/google-calendar/api.server";
import { meetingConsumesTourSlot, meetingPaintsCalendarGrid } from "@/components/portal/portal-calendar-panels";
import { slotBlocked } from "@/lib/tour-slot-math";
import {
  PROPLANE_GOOGLE_CALENDAR_MARKER,
  PROPLANE_TOUR_TYPE_MARKER,
  PROPLANE_WORK_ORDER_TYPE_MARKER,
} from "@/lib/google-calendar/markers";

function event(overrides: Partial<GoogleCalendarApiEvent> & Pick<GoogleCalendarApiEvent, "summary">): GoogleCalendarApiEvent {
  return {
    id: "evt-1",
    start: "2026-08-02T15:00:00-07:00",
    end: "2026-08-02T15:30:00-07:00",
    ...overrides,
  };
}

describe("google calendar meetings", () => {
  it("classifies PropPlane tour events and shows their title", () => {
    expect(
      isGoogleCalendarTourEvent(
        event({
          summary: "Tour · Alex Kim",
          description: `${PROPLANE_TOUR_TYPE_MARKER}\nGuest: Alex Kim\nEmail: alex@example.com\n${PROPLANE_GOOGLE_CALENDAR_MARKER}`,
        }),
      ),
    ).toBe(true);

    const [meeting] = googleCalendarEventsToMeetings([
      event({
        summary: "Tour · Alex Kim",
        description: `${PROPLANE_TOUR_TYPE_MARKER}\nGuest: Alex Kim\nEmail: alex@example.com\n${PROPLANE_GOOGLE_CALENDAR_MARKER}`,
      }),
    ]);
    expect(meeting?.kind).toBe("tour");
    expect(meeting?.title).toBe("Tour · Alex Kim");
    expect(meeting?.statusLabel).toBe("Confirmed");
    expect(meeting?.name).toBe("Alex Kim");
    expect(isGoogleCalendarPrivateBlock(meeting!)).toBe(false);
    expect(meetingCalendarGridLabel(meeting!)).toContain("Confirmed");
  });

  it("parses PropPlane Google description into guest fields", () => {
    const parsed = parseProplaneGoogleCalendarDescription(
      "Type: tour\nGuest: s\nEmail: s@gmail.com\nPhone: +14330033333\nNotes: Property: Ballard House · 3 rooms\nRoom: Not sure which room yet\nCreated from PropPlane",
    );
    expect(parsed.guestName).toBe("s");
    expect(parsed.email).toBe("s@gmail.com");
    expect(parsed.propertyTitle).toBe("Ballard House · 3 rooms");
    expect(parsed.roomLabel).toBe("Not sure which room yet");
  });

  it("blocks personal Google events without exposing titles", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Dentist appointment", description: "Private note" }),
    ]);
    expect(meeting?.title).toBe("Blocked");
    expect(meeting?.googleCalendarPrivate).toBe(true);
    expect(isGoogleCalendarPrivateBlock(meeting!)).toBe(true);
    expect(meetingCalendarGridLabel(meeting!)).toBe("Blocked");
  });

  it("classifies PropPlane work order events", () => {
    expect(
      isGoogleCalendarWorkOrderEvent(
        event({
          summary: "Acme Plumbing · Leaky faucet",
          description: `${PROPLANE_WORK_ORDER_TYPE_MARKER}\n${PROPLANE_GOOGLE_CALENDAR_MARKER}`,
        }),
      ),
    ).toBe(true);

    const [meeting] = googleCalendarEventsToMeetings([
      event({
        summary: "My work · Replace filter",
        description: `${PROPLANE_WORK_ORDER_TYPE_MARKER}\n${PROPLANE_GOOGLE_CALENDAR_MARKER}`,
      }),
    ]);
    expect(meeting?.kind).toBe("service");
    expect(meeting?.title).toBe("My work · Replace filter");
    expect(meeting?.statusLabel).toBe("Scheduled");
    expect(isGoogleCalendarPrivateBlock(meeting!)).toBe(false);
  });
});

/**
 * The manager's "N open" headers count a slot as taken when a meeting occupies
 * it, so what becomes a meeting here has to be exactly what the public booking
 * route subtracts. When only the public side filtered, a declined invite at 2pm
 * vanished from the manager's remaining capacity while the page still sold 2pm.
 */
describe("every Google event still renders; only some count as taken", () => {
  it("still draws an event the manager marked Free, but does not count it", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Focus time", transparency: "transparent" }),
    ]);
    expect(meeting).toBeDefined();
    expect(meeting!.blocksTourAvailability).toBe(false);
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
  });

  it("still draws an invite the manager declined, but does not count it", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Someone else's meeting", declinedBySelf: true }),
    ]);
    expect(meeting).toBeDefined();
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
  });

  it("keeps a PropLane service visit visible even when marked Free", () => {
    // It is PropLane's own pushed event; vanishing from the manager's calendar
    // because someone flipped it to Free would be a visible regression.
    const [meeting] = googleCalendarEventsToMeetings([
      event({
        summary: "My work · Replace filter",
        description: `${PROPLANE_WORK_ORDER_TYPE_MARKER}\n${PROPLANE_GOOGLE_CALENDAR_MARKER}`,
        transparency: "transparent",
      }),
    ]);
    expect(meeting?.kind).toBe("service");
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
  });

  it("AXI-161: an all-day entry the manager left FREE does not consume the day", () => {
    // All-day used to block unconditionally, so every birthday, reminder and bin
    // day wiped a whole day of tours — a linked calendar "blocked everything"
    // and Free/Busy, the one control Google gives the manager, was ignored on
    // exactly those events.
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Bin day", transparency: "transparent", allDay: true }),
    ]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
  });

  it("an all-day entry marked BUSY still consumes it", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Out of town", transparency: "opaque", allDay: true }),
    ]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(true);
  });

  it("out-of-office blocks whatever its transparency says", () => {
    // Google's own "I am not available" type — a genuine absence must still block.
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "PTO", transparency: "transparent", allDay: true, eventType: "outOfOffice" }),
    ]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(true);
  });

  it("counts an ordinary busy event", () => {
    const [meeting] = googleCalendarEventsToMeetings([event({ summary: "Dentist" })]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(true);
    expect(meetingPaintsCalendarGrid(meeting!)).toBe(true);
  });

  it("does not block or paint working-location metadata", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({
        summary: "Home",
        transparency: "opaque",
        allDay: true,
        eventType: "workingLocation",
      }),
    ]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
    expect(meetingPaintsCalendarGrid(meeting!)).toBe(false);
  });

  it("does not block or paint birthday entries", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({
        summary: "Alex's birthday",
        transparency: "opaque",
        allDay: true,
        eventType: "birthday",
      }),
    ]);
    expect(meetingConsumesTourSlot(meeting!)).toBe(false);
    expect(meetingPaintsCalendarGrid(meeting!)).toBe(false);
  });

  it("paints a Free Google block as Free rather than Blocked", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      event({ summary: "Bin day", transparency: "transparent", allDay: true }),
    ]);
    expect(meeting).toBeDefined();
    expect(meetingPaintsCalendarGrid(meeting!)).toBe(true);
    expect(meetingCalendarGridLabel(meeting!)).toBe("Free");
  });
});

/**
 * Google's all-day `end.date` is EXCLUSIVE. For an all-day entry that DOES block
 * (one marked Busy, or an out-of-office), mapping it to `end.date + T23:59:59`
 * meant one "Vacation" day removed TWO days of bookable slots from the grid.
 */
describe("an all-day event covers exactly the days it spans", () => {
  it("ends at midnight ON the exclusive end date, not the end of it", () => {
    const mapped = googleCalendarApiEventFromListItem({
      id: "all-day-1",
      summary: "Vacation",
      start: { date: "2099-08-06" },
      end: { date: "2099-08-07" },
    });
    expect(mapped?.allDay).toBe(true);
    expect(mapped?.start).toBe("2099-08-06T00:00:00");
    expect(mapped?.end).toBe("2099-08-07T00:00:00");
  });

  it("does not subtract the day AFTER a one-day all-day entry", () => {
    const mapped = googleCalendarApiEventFromListItem({
      id: "all-day-1",
      summary: "Vacation",
      start: { date: "2099-08-06" },
      end: { date: "2099-08-07" },
    })!;
    const block = { start: mapped.start, end: mapped.end };
    // Every half hour of Aug 6 is gone…
    expect(slotBlocked("2099-08-06:0", [block])).toBe(true);
    expect(slotBlocked("2099-08-06:20", [block])).toBe(true);
    expect(slotBlocked("2099-08-06:47", [block])).toBe(true);
    // …and Aug 7 opens as normal.
    expect(slotBlocked("2099-08-07:0", [block])).toBe(false);
    expect(slotBlocked("2099-08-07:20", [block])).toBe(false);
  });

  it("still covers every day of a multi-day all-day entry", () => {
    const mapped = googleCalendarApiEventFromListItem({
      id: "all-day-2",
      summary: "Conference",
      start: { date: "2099-08-06" },
      end: { date: "2099-08-09" },
    })!;
    const block = { start: mapped.start, end: mapped.end };
    for (const day of ["2099-08-06", "2099-08-07", "2099-08-08"]) {
      expect(slotBlocked(`${day}:20`, [block])).toBe(true);
    }
    expect(slotBlocked("2099-08-09:20", [block])).toBe(false);
  });

  it("draws a one-day all-day entry as exactly one day of slots", () => {
    const [meeting] = googleCalendarEventsToMeetings([
      googleCalendarApiEventFromListItem({
        id: "all-day-1",
        summary: "Vacation",
        start: { date: "2099-08-06" },
        end: { date: "2099-08-07" },
      })!,
    ]);
    expect(meeting?.span).toBe(48);
  });

  it("leaves a timed event's end alone", () => {
    const mapped = googleCalendarApiEventFromListItem({
      id: "timed-1",
      summary: "Dentist",
      start: { dateTime: "2099-08-06T15:00:00-07:00" },
      end: { dateTime: "2099-08-06T15:30:00-07:00" },
    });
    expect(mapped?.allDay).toBe(false);
    expect(mapped?.end).toBe("2099-08-06T15:30:00-07:00");
  });
});
