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
import { fillReminderTemplate } from "@/lib/reminders/subject-settings-meta";
import { formatMinutes } from "@/lib/reminders/timings";

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
  customSubject?: string | null;
  customBody?: string | null;
  amountLabel?: string | null;
  dueDateLabel?: string | null;
  duePhrase?: string | null;
  applicantName?: string | null;
  residentName?: string | null;
  paymentTitle?: string | null;
  chargeTitle?: string | null;
  leaseUrl?: string | null;
  resumeUrl?: string | null;
  applyUrl?: string | null;
};

export type RenderedReminder = { subject: string; body: string };

/**
 * Drop a "property title" that is really an identifier.
 *
 * Some records carry a slug (`mgr-demo-ballard`) in the title field. Saying
 * "your tour at mgr-demo-ballard" to a prospect is worse than saying nothing,
 * so an id-shaped value is treated as absent and the sentence closes cleanly
 * without it.
 */
export function humanPropertyLabel(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const looksLikeId = !value.includes(" ") && /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(value);
  return looksLikeId ? null : value;
}

/** "in 30 minutes", "in 1 day", "1 day ago" — the lead time as a person would say it. */
export function leadPhrase(leadMinutes: number): string {
  if (leadMinutes < 0) {
    return `${formatMinutes(Math.abs(leadMinutes))} ago`;
  }
  return formatLeadLabel(leadMinutes).replace(/ before$/, "").replace(/^/, "in ");
}

const SUBJECT_NOUN: Record<ReminderSubjectKind, string> = {
  inspection: "room inspection",
  inspection_manager: "inspection review",
  tour: "tour",
  task: "task",
  service_order: "service visit",
  work_order: "maintenance visit",
  application: "application",
  application_manager: "application",
  application_post_tour: "tour follow-up",
  lease: "lease",
  lease_manager: "lease",
  payment_manager: "payment",
  outgoing_payment: "payment",
  booking: "booking",
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
  return kind === "task" || kind === "outgoing_payment";
}

function templateContextFromPayload(
  kind: ReminderSubjectKind,
  leadMinutes: number,
  payload: ReminderPayload,
): Record<string, string> {
  const title = (payload.title ?? "").trim();
  const property = humanPropertyLabel(payload.propertyLabel) ?? (payload.propertyLabel ?? "").trim();
  const counterparty = (payload.counterpartyName ?? "").trim();
  const manager = (payload.managerName ?? "").trim() || "Your property manager";
  const when = (payload.whenLabel ?? "").trim();
  const url = (payload.url ?? "").trim();
  const recipient = (payload.recipientName ?? "").trim();
  const phrase = payload.duePhrase?.trim() || leadPhrase(leadMinutes);

  return {
    recipientName: recipient || counterparty || "there",
    title,
    paymentTitle: (payload.paymentTitle ?? title).trim(),
    chargeTitle: (payload.chargeTitle ?? payload.paymentTitle ?? title).trim(),
    propertyTitle: property,
    counterpartyName: counterparty,
    applicantName: (payload.applicantName ?? counterparty).trim(),
    residentName: (payload.residentName ?? counterparty).trim(),
    managerName: manager,
    whenLabel: when,
    duePhrase: phrase,
    dueDateLabel: (payload.dueDateLabel ?? when).trim(),
    amountLabel: (payload.amountLabel ?? "").trim(),
    url,
    leaseUrl: (payload.leaseUrl ?? url).trim(),
    resumeUrl: (payload.resumeUrl ?? url).trim(),
    applyUrl: (payload.applyUrl ?? url).trim(),
    notes: (payload.notes ?? "").trim(),
    kind,
  };
}

export function renderReminder(input: {
  kind: ReminderSubjectKind;
  leadMinutes: number;
  recipientRole: "manager" | "counterparty" | "team";
  payload: ReminderPayload;
}): RenderedReminder {
  const { kind, leadMinutes, payload } = input;
  const customSubject = (payload.customSubject ?? "").trim();
  const customBody = (payload.customBody ?? "").trim();
  if (customSubject || customBody) {
    const context = templateContextFromPayload(kind, leadMinutes, payload);
    return fillReminderTemplate(
      { subject: customSubject || "Reminder", body: customBody || "" },
      context,
    );
  }

  const recipientRole = input.recipientRole === "team" ? "manager" : input.recipientRole;
  const noun = SUBJECT_NOUN[kind];
  const phrase = leadPhrase(leadMinutes);
  const title = (payload.title ?? "").trim();
  const when = (payload.whenLabel ?? "").trim();
  const property = humanPropertyLabel(payload.propertyLabel) ?? "";
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
