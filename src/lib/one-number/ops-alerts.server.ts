import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { toGsm7 } from "@/lib/one-number/segments";
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
  | "unanswered_question";

const SUBJECT: Record<OpsAlertKind, string> = {
  new_application: "New application",
  tour_booked: "Tour booked",
  emergency_maintenance: "Emergency service",
  payment_failed: "Payment failed",
  payment_late: "Late fee applied",
  unanswered_question: "Question needs an answer",
};

export const OPS_ALERT_KINDS = Object.keys(SUBJECT) as OpsAlertKind[];

/** One short plain line, GSM-7, no card or bank numbers, no longer than a segment or two. */
export function alertLine(text: string): string {
  const redacted = redactSensitiveNumbers(text.replace(/\s+/g, " ").trim()).text;
  return toGsm7(redacted).slice(0, 220);
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
};

export async function alertPhonesOf(db: SupabaseClient, input: AlertPhonesInput): Promise<{ texted: number; emailed: number }> {
  const none = { texted: 0, emailed: 0 };
  try {
    const ownerUserId = input.ownerUserId.trim();
    const entityId = input.entityId.trim();
    const text = alertLine(input.text);
    if (!ownerUserId || !entityId || !text) return none;
    const workspaceId = input.workspaceId?.trim() || (await resolveWorkspaceForProperty(db, input.propertyId?.trim() || null, ownerUserId));
    return await notifyWorkNumberRecipients(db, {
      ownerUserId,
      workspaceId,
      subject: SUBJECT[input.kind],
      text,
      ...(input.url ? { url: input.url } : {}),
      idempotencyKey: `ops-alert:${input.kind}:${entityId}`,
    });
  } catch {
    // Masked: neither a number nor the body reaches a log.
    console.error("ops alert failed", input.kind);
    return none;
  }
}
