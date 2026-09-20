/**
 * A reminder row already knows its subject — `kind` + `subjectId` — because
 * that is what {@link claimDueReminders} claims against. Turning that into a
 * `RecordRef` is what lets a late-rent reminder show up UNDER that charge's
 * own Communication section instead of just floating in the inbox.
 *
 * Deliberately conservative: only kinds this file can confidently map to one
 * unambiguous record id are covered (see `docs/agents/communication-inbox.md`
 * § recordRef). An unmapped kind returns `null` — no recordRef, never a
 * guessed one — rather than trying to cover every one of the ~45 reminder
 * kinds under budget.
 */
import type { RecordKind } from "@/lib/portals/record-kinds";
import type { ReminderPayload } from "@/lib/reminders/render";
import type { ReminderSubjectKind } from "@/lib/reminders/rules";

const RECORD_KIND_BY_REMINDER_KIND: Partial<Record<ReminderSubjectKind, RecordKind>> = {
  payment_manager: "payment",
  outgoing_payment: "outgoing-payment",
  lease: "lease",
  lease_manager: "lease",
  application: "application",
  application_manager: "application",
  application_post_tour: "application",
  service_order: "service",
  work_order: "service",
  inspection: "inspection",
  inspection_manager: "inspection",
  tour: "tour",
  tour_interest: "tour",
  booking: "booking",
};

function labelFor(kind: ReminderSubjectKind, payload: ReminderPayload, subject: string): string {
  const candidate =
    (payload.chargeTitle ?? "").trim() ||
    (payload.paymentTitle ?? "").trim() ||
    (payload.title ?? "").trim() ||
    subject.trim();
  return candidate.slice(0, 140);
}

/** Booking subjects are prefixed (`stay:<id>` / `channel:<connectionId>:<rangeId>`); only a `stay:` id names one page-able booking record. */
function bookingRecordId(subjectId: string): string | null {
  if (subjectId.startsWith("stay:")) return subjectId.slice("stay:".length);
  return null;
}

export function recordRefFromReminderRow(
  kind: ReminderSubjectKind,
  subjectId: string,
  payload: ReminderPayload,
  renderedSubject: string,
): { kind: RecordKind; id: string; label: string } | null {
  const recordKind = RECORD_KIND_BY_REMINDER_KIND[kind];
  if (!recordKind) return null;
  const id = recordKind === "booking" ? bookingRecordId(subjectId) : subjectId.trim();
  if (!id) return null;
  const label = labelFor(kind, payload, renderedSubject);
  if (!label) return null;
  return { kind: recordKind, id, label };
}
