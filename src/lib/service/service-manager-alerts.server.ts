import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toGsm7 } from "@/lib/one-number/segments";
import { rateLimit } from "@/lib/rate-limit";
import { readServiceManagerSettings, sendToServiceManager } from "@/lib/service/service-manager.server";
import { serviceWorkspaceLabel } from "@/lib/service/service-label";

/**
 * Manager alerts for PropLane Service workspaces go to the service manager's verified phone (captain, Oct 19:
 * "notified if people are wanting to see a house for short term or long term... new applications, filed services,
 * vendor replies needing a decision, escalations, payments received or failed").
 *
 * ONE chokepoint: every manager notice in the product (the action-event bus, the leasing and vendor agents' escalations,
 * the team alerts, dispatch) ends in `notifyManagerFromAgent`, which calls this for the notice's workspace. A workspace
 * that is not `is_service` returns here untouched, so no other workspace's notice can ever be texted to this number.
 *
 * The text is one short line from the PropLane line. One event is one text: the dedupe key drops the per-recipient
 * suffix, so the owner's notice, a teammate's and the Team line of the same event collapse.
 */

/** Notices that are bookkeeping, not something the service manager acts on. */
const QUIET_CATEGORIES = new Set(["attention_digest"]);
const MAX_ALERT_CHARS = 300;

/**
 * Inquiry alerts go to one person's personal cell, so the per-phone-per-day throttle is not enough on its own:
 * rotating (or spoofed) senders would each get their own daily text. This whole-line hourly cap bounds the cost
 * and the flood the way the sign-up path's global cap does.
 */
export const SERVICE_INQUIRY_ALERTS_PER_HOUR = 20;

/** The same event, whoever it was fanned out to: drop `:manager` / `:team` / `:<userId>` suffixes of an idempotency key. */
export function serviceAlertEventKey(idempotencyKey: string | null | undefined, fallback: string): string {
  const base = (idempotencyKey ?? "")
    .replace(/:(manager|team|assistant)$/i, "")
    .replace(/:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
  return createHash("sha256").update(base || fallback).digest("hex").slice(0, 32);
}

export function composeServiceAlertText(input: { workspaceName: string; subject: string; text: string }): string {
  const label = serviceWorkspaceLabel(input.workspaceName);
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.text.replace(/\s+/g, " ").trim();
  const detail = body && body.toLowerCase() !== subject.toLowerCase() && !body.toLowerCase().startsWith(subject.toLowerCase()) ? ` - ${body}` : "";
  const line = toGsm7(`PropLane ${label}: ${subject}${detail}`);
  return line.length <= MAX_ALERT_CHARS ? line : `${line.slice(0, MAX_ALERT_CHARS - 3).trimEnd()}...`;
}

export async function alertServiceManagerFromNotice(
  db: SupabaseClient,
  input: {
    workspaceId: string | null | undefined;
    subject: string;
    text: string;
    externalText?: string;
    category?: string;
    threadType?: string;
    idempotencyKey?: string;
  },
): Promise<"sent" | "skipped"> {
  try {
    const workspaceId = input.workspaceId?.trim();
    if (!workspaceId) return "skipped";
    const category = input.category ?? "messages";
    if (QUIET_CATEGORIES.has(category)) return "skipped";
    // Payment REMINDER confirmations are noise; a payment event (received, failed) is a bus event.
    if (category === "payment_reminders" && input.threadType !== "action_event") return "skipped";

    const { data, error } = await db.from("portal_workspaces").select("name, is_service").eq("id", workspaceId).maybeSingle();
    const ws = data as { name?: unknown; is_service?: unknown } | null;
    if (error || ws?.is_service !== true) return "skipped";
    const settings = await readServiceManagerSettings(db);
    if (!settings?.phoneE164 || !settings.verifiedAt) return "skipped";

    const text = composeServiceAlertText({
      workspaceName: String(ws.name ?? ""),
      subject: input.subject,
      text: input.externalText ?? input.text,
    });
    // Without an idempotency key the fallback hashes the words, and `sendToServiceManager` dedupes forever: a later
    // notice whose subject and text are byte-identical (a recurring "New message") was dropped for good. The day
    // bucket keeps one-per-day for a repeat while still collapsing the same event's fan-out.
    const day = new Date().toISOString().slice(0, 10);
    const key = serviceAlertEventKey(input.idempotencyKey, `${workspaceId}|${input.subject}|${input.text}|${day}`);
    const sent = await sendToServiceManager(db, { text, dedupeKey: `svc-mgr-alert-${workspaceId.slice(0, 8)}-${key}`, settings });
    return sent.ok ? "sent" : "skipped";
  } catch (error) {
    console.error("service manager alert failed", error instanceof Error ? error.name : "unknown");
    return "skipped";
  }
}

/**
 * A new person wrote to the PropLane line wanting a house (a prospect inquiry, short stay or long term). Texted once per
 * phone per day, under a whole-line hourly cap that only a text which really goes out can spend. The number is shown by
 * its last four digits only; the whole thread is in Admin Communication.
 */
/**
 * Has this phone's inquiry already produced an alert today? A read of the outbox row the transport dedupes on, so
 * it costs no budget and cannot itself become a suppression lever. An unreadable outbox answers "no": the transport
 * dedupe is still authoritative, so the worst case is one extra attempt that it collapses.
 */
async function inquiryAlreadyAlerted(db: SupabaseClient, ownerUserId: string, dedupeKey: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("sms_outbox")
      .select("id")
      .eq("manager_user_id", ownerUserId)
      .eq("dedupe_key", dedupeKey)
      .limit(1)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export async function alertServiceManagerOfInquiry(
  db: SupabaseClient,
  input: { phone: string; body: string; now?: Date },
): Promise<"sent" | "skipped"> {
  try {
    const settings = await readServiceManagerSettings(db);
    if (!settings?.phoneE164 || !settings.verifiedAt) return "skipped";
    const digits = input.phone.replace(/\D/g, "");
    if (digits.length < 10) return "skipped";
    const snippet = input.body.replace(/\s+/g, " ").trim().slice(0, 110);
    const text = toGsm7(`PropLane line: new inquiry from ***${digits.slice(-4)}${snippet ? `: "${snippet}"` : ""}`);
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const dedupeKey = `svc-inquiry-${digits.slice(-10)}-${day}`;
    // This phone's own daily slot is PEEKED, never consumed: the outbox row the transport writes under the same key
    // is the state, so reading it spends nothing. A limiter was wrong here twice over - spending the phone's slot
    // before the line's cap allowed the send silenced a genuinely new prospect for a day while a flood held the cap
    // saturated, and a limiter outage silenced every alert at once.
    if (await inquiryAlreadyAlerted(db, settings.ownerUserId, dedupeKey)) return "skipped";
    // Then the whole-line hourly cap: a sender rotating numbers must not be able to text this phone without limit.
    // An unreachable limiter lets the alert through - the per-phone dedupe still bounds it to one per number per day.
    const budget = await rateLimit("service-manager-inquiry-alert", SERVICE_INQUIRY_ALERTS_PER_HOUR, 60 * 60 * 1000);
    if (!budget.ok && !budget.unavailable) return "skipped";
    const sent = await sendToServiceManager(db, { text, dedupeKey, settings });
    return sent.ok ? "sent" : "skipped";
  } catch {
    return "skipped";
  }
}
