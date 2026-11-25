import { PROPLANE_GOOGLE_CALENDAR_MARKER, PROPLANE_TOUR_TYPE_MARKER } from "@/lib/google-calendar/markers";
import { managerTourDetailHref, plannedTourRowId } from "@/lib/portal-detail-routes";
import { normalizeTourFormat, tourFormatLabel } from "@/lib/tour-format";

/** What a Google Calendar tour event is built from: the planned-tour record's own facts. */
export type TourEventFacts = {
  plannedEventId: string;
  title: string;
  propertyTitle?: string;
  roomLabel?: string;
  /** "in_person" | "virtual"; anything else reads as in person (`normalizeTourFormat`). */
  tourFormat?: string | null;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  instructions?: string;
};

/**
 * The link that opens this CONFIRMED tour in the manager's portal Tours: the Upcoming bucket's detail route for the
 * row id `plannedTourRowId` mints, which is what the Tours list resolves by. A request that is not confirmed yet opens
 * by `managerTourRequestDeepLink` instead.
 */
export function tourEventDeepLink(origin: string, plannedEventId: string): string {
  return `${origin.replace(/\/$/, "")}${managerTourDetailHref("/portal", "upcoming", plannedTourRowId(plannedEventId))}`;
}

/** "Tour · Ana · 5257 Room 6 (virtual)": who, where and how, so the calendar grid says it without opening the event. */
export function tourEventSummary(facts: Pick<TourEventFacts, "title" | "roomLabel" | "tourFormat">): string {
  const base = facts.title?.trim() || "Tour";
  const room = facts.roomLabel?.trim();
  const withRoom = room && !base.toLowerCase().includes(room.toLowerCase()) ? `${base} · ${room}` : base;
  return normalizeTourFormat(facts.tourFormat) === "virtual" ? `${withRoom} (virtual)` : withRoom;
}

/** One place for the event body: prospect, property + room, in person vs virtual, contact, and the PropLane link. */
export function tourEventDescription(facts: TourEventFacts, origin: string): string {
  return [
    PROPLANE_TOUR_TYPE_MARKER,
    facts.attendeeName ? `Guest: ${facts.attendeeName}` : null,
    facts.propertyTitle ? `Property: ${facts.propertyTitle}` : null,
    facts.roomLabel?.trim() ? `Room: ${facts.roomLabel.trim()}` : null,
    `Format: ${tourFormatLabel(facts.tourFormat)}`,
    facts.attendeeEmail ? `Email: ${facts.attendeeEmail}` : null,
    facts.attendeePhone ? `Phone: ${facts.attendeePhone}` : null,
    facts.notes ? `Notes: ${facts.notes}` : null,
    facts.instructions ? `Instructions: ${facts.instructions}` : null,
    facts.plannedEventId ? `Open in PropLane: ${tourEventDeepLink(origin, facts.plannedEventId)}` : null,
    PROPLANE_GOOGLE_CALENDAR_MARKER,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The planned-event record's calendar facts, for every caller that rebuilds the event from the stored row. */
export function tourEventFactsFromRecord(record: Record<string, unknown> | null | undefined): Pick<TourEventFacts, "roomLabel" | "tourFormat"> {
  const text = (key: string) => (typeof record?.[key] === "string" ? (record[key] as string).trim() : "");
  return { roomLabel: text("roomLabel") || undefined, tourFormat: text("tourFormat") || undefined };
}
