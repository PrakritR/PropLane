import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { toGsm7 } from "@/lib/one-number/segments";
import { alertServiceManagerFromNotice } from "@/lib/service/service-manager-alerts.server";
import { notifyWorkNumberRecipients } from "@/lib/work-number-recipients.server";

/**
 * W8 alerts. The spec's six team alerts are: new application, booked tour, emergency maintenance,
 * failed or late payment, HUMAN request, unanswerable question. Which path owns each:
 *
 *   HUMAN, emergency word, new lead     `alertWorkspaceTeam` (W1/W3): owner, teammates, Team chat, alert phones
 *   new application                     `notifyManagerApplicationSubmitted`: owner + house teammates
 *   booked tour                         `emitTourManagerEvent` (confirmed): owner + the Team chat line
 *   emergency maintenance               `emitCreatedWorkOrder`: managers of that house
 *   failed / late payment               `emitHouseholdChargeTransition`: manager notice
 *   unanswerable question               the escalation tools' own manager notice
 *
 * Each of those already reaches the owner and the people who hold the house. What none of them reached
 * was the owner's listed ALERT PHONES (the "Also notify" numbers that have no PropLane account).
 *
 * W30 adds the leg the spec's second list needs, all through the same function: the 7 AM check-in / check-out line
 * per house (`checkin_checkout_today`, `checkin-digest.server.ts`), a new booking from any channel or from
 * PropLane (`booking_created`: `emitChannelBookingEvent` / `emitNativeBookingEvent` / `emitShortStayRequestedEvent`),
 * a tour requested or cancelled by the guest (`notifyManagerTourRequest` / `emitTourManagerEvent`) and an
 * application started (`persistNormalizedRow`, the first insert of an applicant's own draft).
 *
 * `alertPhonesOf` is that one missing leg: it adds nothing for the owner or the team (so nobody is
 * told twice), only texts and emails the listed numbers through the existing
 * `notifyWorkNumberRecipients`. It never throws and never blocks the event it follows.
 */

export type OpsAlertKind =
  | "new_application"
  | "tour_booked"
  | "emergency_maintenance"
  | "payment_failed"
  | "payment_late"
  | "unanswered_question"
  | "checkin_checkout_today"
  | "booking_created"
  | "tour_requested"
  | "tour_cancelled"
  | "application_started";

const SUBJECT: Record<OpsAlertKind, string> = {
  new_application: "New application",
  tour_booked: "Tour booked",
  emergency_maintenance: "Emergency service",
  payment_failed: "Payment failed",
  payment_late: "Late fee applied",
  unanswered_question: "Question needs an answer",
  checkin_checkout_today: "Check-ins and check-outs today",
  booking_created: "New booking",
  tour_requested: "Tour requested",
  tour_cancelled: "Tour cancelled",
  application_started: "Application started",
};

/**
 * The kinds the PropLane Service manager phone does NOT already hear about through the notice spine
 * (`notifyManagerFromAgent` -> `alertServiceManagerFromNotice`: bookings, tours, applications submitted, services, payments).
 * For a PropLane-managed (`is_service`) workspace these two reach that phone as well; every other kind would be a second text.
 */
const SERVICE_MANAGER_KINDS: ReadonlySet<OpsAlertKind> = new Set<OpsAlertKind>(["checkin_checkout_today", "application_started"]);

/** The digest runs longer than a one-sentence alert: up to three segments, never cut mid-stay. */
const MAX_CHARS: Partial<Record<OpsAlertKind, number>> = { checkin_checkout_today: 440 };
const DEFAULT_MAX_CHARS = 220;

export const OPS_ALERT_KINDS = Object.keys(SUBJECT) as OpsAlertKind[];

/** One short plain line, GSM-7, no card or bank numbers, no longer than a segment or two. */
export function alertLine(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  const redacted = redactSensitiveNumbers(text.replace(/\s+/g, " ").trim()).text;
  return toGsm7(redacted).slice(0, maxChars);
}

export type AlertPhonesInput = {
  /** The workspace owner whose alert list is used. */
  ownerUserId: string;
  kind: OpsAlertKind;
  text: string;
  /** What the alert is about (application id, tour id, charge id, ...): the retry key. */
  entityId: string;
  /** The house, when known: picks the workspace whose number the text leaves from. */
  propertyId?: string | null;
  workspaceId?: string | null;
  url?: string;
  /**
   * The retry key when this event ALSO rides the action-event bus (`action-event:<eventId>:manager`), which already texts
   * the same alert phones under that key: sharing it makes whichever leg runs second a no-op, so a booking is one text
   * when the bus delivered it and still one text when the manager's per-event switch muted the bus.
   */
  idempotencyKey?: string;
};

export async function alertPhonesOf(db: SupabaseClient, input: AlertPhonesInput): Promise<{ texted: number; emailed: number }> {
  const none = { texted: 0, emailed: 0 };
  try {
    const ownerUserId = input.ownerUserId.trim();
    const entityId = input.entityId.trim();
    const text = alertLine(input.text, MAX_CHARS[input.kind] ?? DEFAULT_MAX_CHARS);
    if (!ownerUserId || !entityId || !text) return none;
    const workspaceId = input.workspaceId?.trim() || (await resolveWorkspaceForProperty(db, input.propertyId?.trim() || null, ownerUserId));
    const idempotencyKey = input.idempotencyKey?.trim() || `ops-alert:${input.kind}:${entityId}`;
    const out = await notifyWorkNumberRecipients(db, {
      ownerUserId,
      workspaceId,
      subject: SUBJECT[input.kind],
      text,
      ...(input.url ? { url: input.url } : {}),
      idempotencyKey,
    });
    // A PropLane-managed workspace's Service-settings phone (verified, `platform_service_settings`) hears the kinds the
    // notice spine never carried to it. Own idempotency, its own failure: it never changes what the alert phones got.
    if (SERVICE_MANAGER_KINDS.has(input.kind) && workspaceId) {
      await alertServiceManagerFromNotice(db, { workspaceId, subject: SUBJECT[input.kind], text, idempotencyKey }).catch(() => "skipped");
    }
    return out;
  } catch {
    // Masked: neither a number nor the body reaches a log.
    console.error("ops alert failed", input.kind);
    return none;
  }
}
