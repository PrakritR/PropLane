/**
 * Reminder copy.
 *
 * Pure so it can be unit-tested and previewed in Settings without a database.
 * Every field comes from the payload snapshotted when the reminder was queued,
 * so a reminder describes the appointment as it was agreed rather than
 * re-reading a subject that may have changed underneath it.
 *
 * The two sides read differently on purpose. The counterparty is being told
 * about *their* appointment ("your tour is in 30 minutes"); the manager is
 * being told about someone else's ("Priya's tour is in 30 minutes"). Sending
 * one voice to both is how reminders end up sounding like spam to the person
 * who scheduled them.
 */
import { formatLeadLabel, type ReminderSubjectKind } from "@/lib/reminders/rules";

export type ReminderPayload = {
  /** What the thing is called: a task title, a tour's property, a service name. */
  title?: string | null;
  /** Human time of the anchor, pre-formatted in the manager's zone. */
  whenLabel?: string | null;
  propertyLabel?: string | null;
  locationLabel?: string | null;
  /** The non-manager party, for the manager's copy. */
  counterpartyName?: string | null;
  managerName?: string | null;
  /** Deep link into the portal. Omitted from the body when absent. */
  url?: string | null;
  recipientName?: string | null;
  notes?: string | null;
};

export type RenderedReminder = { subject: string; body: string };

/** "in 30 minutes", "in 1 day" — the lead time as a person would say it. */
export function leadPhrase(leadMinutes: number): string {
  return formatLeadLabel(leadMinutes).replace(/ before$/, "").replace(/^/, "in ");
}

const SUBJECT_NOUN: Record<ReminderSubjectKind, string> = {
  tour: "tour",
  task: "task",
  service_order: "service visit",
  work_order: "maintenance visit",
  booking: "stay",
};

function greeting(name?: string | null): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? `Hi ${trimmed},` : "Hi,";
}

function lines(parts: (string | null | undefined)[]): string {
  return parts
    .map((part) => (part ?? "").replace(/\s+$/g, ""))
    .filter((part, index, all) => part !== "" || (index > 0 && all[index - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A task is the one subject whose anchor is a DEADLINE rather than an
 * appointment, so it reads "due in 1 day", never "starts in 1 day".
 */
function isDeadline(kind: ReminderSubjectKind): boolean {
  return kind === "task";
}

export function renderReminder(input: {
  kind: ReminderSubjectKind;
  leadMinutes: number;
  recipientRole: "manager" | "counterparty";
  payload: ReminderPayload;
}): RenderedReminder {
  const { kind, leadMinutes, recipientRole, payload } = input;
  const noun = SUBJECT_NOUN[kind];
  const phrase = leadPhrase(leadMinutes);
  const title = (payload.title ?? "").trim();
  const when = (payload.whenLabel ?? "").trim();
  const property = (payload.propertyLabel ?? "").trim();
  const location = (payload.locationLabel ?? "").trim();
  const counterparty = (payload.counterpartyName ?? "").trim();
  const manager = (payload.managerName ?? "").trim() || "Your property manager";
  const url = (payload.url ?? "").trim();
  const notes = (payload.notes ?? "").trim();

  const verb = isDeadline(kind) ? "due" : "starts";

  const subject =
    recipientRole === "counterparty"
      ? isDeadline(kind)
        ? `Reminder: ${title || "your task"} is due ${phrase.replace(/^in /, "in ")}`
        : `Reminder: your ${noun}${property ? ` at ${property}` : ""} is ${phrase}`
      : isDeadline(kind)
        ? `${title || "A task"} is due ${phrase}`
        : `${counterparty ? `${counterparty}'s` : "A"} ${noun}${property ? ` at ${property}` : ""} is ${phrase}`;

  const detail = lines([
    when ? `When: ${when}` : null,
    property && !isDeadline(kind) ? `Property: ${property}` : null,
    location ? `Where: ${location}` : null,
    recipientRole === "manager" && counterparty ? `With: ${counterparty}` : null,
    notes ? `Details: ${notes}` : null,
  ]);

  const opening =
    recipientRole === "counterparty"
      ? isDeadline(kind)
        ? `A quick reminder that ${title || "your task"} is ${verb} ${phrase}.`
        : `A quick reminder about your upcoming ${noun}${property ? ` at ${property}` : ""} — it ${verb} ${phrase}.`
      : isDeadline(kind)
        ? `${title || "A task"} is ${verb} ${phrase}.`
        : `${counterparty || "Someone"} has a ${noun}${property ? ` at ${property}` : ""} ${phrase}.`;

  const body = lines([
    greeting(payload.recipientName),
    "",
    opening,
    "",
    detail,
    detail ? "" : null,
    url ? `View it here: ${url}` : null,
    url ? "" : null,
    recipientRole === "counterparty" ? manager : null,
    "PropLane",
  ]);

  return { subject, body };
}
