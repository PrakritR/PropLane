/**
 * The ONE line PropLane posts in the workspace Team chat for a routine notice:
 * "<Event> · <subject> · <house and room> · <who> · <state>", a plain fact line
 * with no glyph, pill or subtext. An urgent event is prefixed "Emergency · ".
 * Pure: the caller supplies the facts it has; a part it lacks is left out.
 * Copy says "service", never "work order" (schema names stay).
 */

const EVENT_LABEL: Record<string, string> = {
  work_order: "Service request",
  service_request: "Service request",
  payment: "Payment",
  lease: "Lease",
  application: "Application",
  tour: "Tour",
  inspection: "Inspection",
  task: "Task",
  message: "Message",
  move_in_form: "Move-in form",
  vendor_banking: "Vendor banking",
  availability: "Availability",
  channel_booking: "Booking",
};

const STATE_BY_EVENT: Record<string, string> = {
  created: "open",
  vendor_offered: "offered",
  vendor_new_service: "offered",
  vendor_assigned: "assigned",
  accepted: "assigned",
  scheduled: "scheduled",
  rescheduled: "rescheduled",
  en_route: "on the way",
  completed: "completed",
  resident_confirmed: "completed",
  auto_closed: "completed",
  cancelled: "cancelled",
  invoiced: "invoiced",
  invoice_approved: "invoice approved",
  invoice_disputed: "invoice disputed",
  paid: "paid",
};

export function teamNoticeEventLabel(domain: string | undefined): string {
  const key = (domain ?? "").trim();
  return EVENT_LABEL[key] ?? (key ? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Update");
}

export function teamNoticeState(event: string | undefined): string {
  const key = (event ?? "").trim();
  return STATE_BY_EVENT[key] ?? key.replace(/_/g, " ");
}

/**
 * A subject is a fact off a row, and a row written before the rename carries
 * the retired word — as its whole title, or as the "Work order · " prefix the
 * stored-title matchers still read. The event label already says what this is,
 * so the word is dropped here rather than read by a person.
 */
function serviceSubject(value: string | null | undefined): string {
  const stripped = (value ?? "").trim().replace(/^work\s*orders?\b[\s·:-]*/i, "").trim();
  return stripped.toLowerCase() === "work order" ? "" : stripped;
}

export function buildTeamNoticeLine(input: {
  domain?: string;
  event?: string;
  /** What the notice is about: a service's title, a charge, a person. */
  subject?: string | null;
  /** The house and room, already joined ("5257 Brooklyn R2"). */
  place?: string | null;
  /** The person who acted or filed it. */
  who?: string | null;
  urgent?: boolean;
}): string {
  const subject = serviceSubject(input.subject);
  const place = input.place?.trim();
  const who = input.who?.trim();
  const state = teamNoticeState(input.event);
  const parts = [
    teamNoticeEventLabel(input.domain),
    subject || "",
    place || "",
    who ? (input.event === "created" ? `filed by ${who}` : who) : "",
    state,
  ].filter(Boolean);
  const line = parts.join(" · ");
  return input.urgent ? `Emergency · ${line}` : line;
}
