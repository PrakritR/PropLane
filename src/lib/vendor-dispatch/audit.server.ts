import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

/**
 * One audit row per dispatch decision, on `action_events` (domain `vendor_dispatch`,
 * category `maintenance`; the migration 20261018120100 admits the domain). Written
 * straight to the table, not through `emitActionEvent`: nothing here fans out as a
 * notice, the row is the record. Idempotent on `event_key`, best-effort, and it
 * reports whether the row landed instead of hiding a failure.
 */
export type DispatchAuditEvent =
  | "created"
  | "approval_requested"
  | "approval_reminded"
  | "approval_escalated"
  | "approved"
  | "approved_pick"
  | "declined_by_manager"
  | "offered"
  | "vendor_accepted"
  | "vendor_declined"
  | "vendor_busy"
  | "vendor_timed_out"
  | "quote_held"
  | "quote_approved"
  | "quote_rejected"
  | "taken"
  | "exhausted"
  | "retried"
  | "canceled"
  | "vendor_done"
  | "vendor_photos"
  | "vendor_reminded"
  | "resident_confirmed"
  | "resident_reopened"
  | "invoice_asked"
  | "invoice_approved"
  | "invoice_rejected"
  | "refused_unverified_lockout"
  /** A turnover clean's window moved because a stay's check-in / checkout time did. */
  | "window_changed";

export async function recordDispatchEvent(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    runId: string;
    handle?: number | null;
    event: DispatchAuditEvent;
    /** The person or vendor who made the decision, when there is one. */
    actorUserId?: string | null;
    channel?: "sms" | "portal" | "system";
    /** Disambiguates repeats of the same event on one run (attempt id, wave number). */
    key?: string;
    /** The verbatim text of the decision (the manager's or vendor's reply). */
    reply?: string | null;
    detail?: Record<string, unknown>;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const eventKey = `vendor_dispatch:${input.runId}:${input.event}${input.key ? `:${input.key}` : ""}`;
  try {
    const { error } = await db.from("action_events").upsert(
      {
        event_key: eventKey,
        domain: "vendor_dispatch",
        event_type: input.event,
        category: "maintenance",
        manager_user_id: input.ownerUserId,
        entity_id: input.runId,
        sender_user_id: input.actorUserId ?? null,
        occurred_at: now.toISOString(),
        processed_at: now.toISOString(),
        payload: stampSmsTestProvenance({
          handle: input.handle ?? null,
          channel: input.channel ?? "system",
          ...(input.reply ? { reply: input.reply.slice(0, 280) } : {}),
          ...(input.detail ?? {}),
        }),
      },
      { onConflict: "event_key", ignoreDuplicates: true },
    );
    if (error) {
      console.error("vendor dispatch audit not recorded", input.event, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("vendor dispatch audit not recorded", input.event, error instanceof Error ? error.message : "unknown");
    return false;
  }
}
