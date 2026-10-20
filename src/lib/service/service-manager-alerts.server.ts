import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toGsm7 } from "@/lib/one-number/segments";
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
    const key = serviceAlertEventKey(input.idempotencyKey, `${workspaceId}|${input.subject}|${input.text}`);
    const sent = await sendToServiceManager(db, { text, dedupeKey: `svc-mgr-alert-${workspaceId.slice(0, 8)}-${key}`, settings });
    return sent.ok ? "sent" : "skipped";
  } catch (error) {
    console.error("service manager alert failed", error instanceof Error ? error.name : "unknown");
    return "skipped";
  }
}
