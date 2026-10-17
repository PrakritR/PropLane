/**
 * The ONE line PropLane posts in the workspace Team chat for a routine notice:
 * one plain sentence, "<Event and what happened>: <subject>, <amount>, <house
 * and room>, <who>." ("Charge created: Kitchen faucet drip, $140, Test
 * Manager."), with no glyph, pill, separator dot or subtext. An urgent event is
 * prefixed "Emergency. ". Pure: the caller supplies the facts it has; a part it
 * lacks is left out. Copy says "service", never "work order" (schema names stay).
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

/** What happened, as the end of the headline ("Service request filed"). */
const HAPPENED_BY_EVENT: Record<string, string> = {
  created: "created",
  vendor_offered: "offered to a vendor",
  vendor_new_service: "offered to a vendor",
  vendor_assigned: "assigned",
  accepted: "accepted",
  scheduled: "scheduled",
  rescheduled: "rescheduled",
  en_route: "vendor on the way",
  completed: "completed",
  resident_confirmed: "confirmed complete",
  auto_closed: "closed",
  cancelled: "cancelled",
  invoiced: "invoiced",
  invoice_approved: "invoice approved",
  invoice_disputed: "invoice disputed",
  paid: "paid",
  reminder_sent: "reminder sent",
};

/** Payment events read as their own headline, whole. */
const PAYMENT_HEADLINE: Record<string, string> = {
  charge_created: "Charge created",
  payment_processing: "Payment processing",
  payment_received: "Payment received",
  partial_received: "Partial payment received",
  payment_failed: "Payment failed",
  payment_refunded: "Payment refunded",
  late_fee_applied: "Late fee applied",
  deposit_received: "Deposit received",
  reminder_sent: "Payment reminder sent",
};

export function teamNoticeEventLabel(domain: string | undefined): string {
  const key = (domain ?? "").trim();
  return EVENT_LABEL[key] ?? (key ? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Update");
}

/** The state an event leaves a record in, in words ("on the way"); empty when the event names none. */
export function teamNoticeState(event: string | undefined): string {
  const key = (event ?? "").trim();
  return HAPPENED_BY_EVENT[key] ?? key.replace(/_/g, " ");
}

function headlineFor(domain: string | undefined, event: string | undefined): string {
  const eventKey = (event ?? "").trim();
  const domainKey = (domain ?? "").trim();
  if (domainKey === "payment" && PAYMENT_HEADLINE[eventKey]) return PAYMENT_HEADLINE[eventKey]!;
  const label = teamNoticeEventLabel(domain);
  // "lease_signed" on the lease domain is "signed", not "lease signed".
  const bare = domainKey && eventKey.startsWith(`${domainKey}_`) ? eventKey.slice(domainKey.length + 1) : eventKey;
  const happened =
    domainKey === "work_order" && eventKey === "created" ? "filed" : HAPPENED_BY_EVENT[bare] ?? bare.replace(/_/g, " ");
  return happened ? `${label} ${happened}` : label;
}

/**
 * A subject is a fact off a row, and a row written before the rename carries
 * the retired word — as its whole title, or as the "Work order · " prefix the
 * stored-title matchers still read. The event label already says what this is,
 * so the word is dropped here rather than read by a person. The "· Payment
 * update" tail an action event's own subject carries is the headline's job too.
 */
function serviceSubject(value: string | null | undefined): string {
  const stripped = (value ?? "")
    .trim()
    .replace(/^work\s*orders?\b[\s·:-]*/i, "")
    .replace(/\s*·\s*payment update\s*$/i, "")
    .trim();
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
  /** An amount already formatted for people ("$140"). */
  amount?: string | null;
  urgent?: boolean;
}): string {
  const details = [
    serviceSubject(input.subject),
    input.amount?.trim() ?? "",
    // "5257 Brooklyn Ave · Room 2" is a label with a separator dot; in a sentence it is a list.
    (input.place?.trim() ?? "").replace(/\s*·\s*/g, ", "),
    input.who?.trim() ?? "",
  ].filter(Boolean);
  const headline = headlineFor(input.domain, input.event);
  const sentence = details.length > 0 ? `${headline}: ${details.join(", ")}.` : `${headline}.`;
  return input.urgent ? `Emergency. ${sentence}` : sentence;
}
