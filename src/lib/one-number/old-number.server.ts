import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { isMissingSchemaError, isSharedLineNumber, loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { sendPlatformLeadText, type PlatformLeadSendResult } from "@/lib/one-number/lead-send.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { e164FromPhoneKey } from "@/lib/one-number/unassigned-leads.server";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";

/**
 * After the switch to the shared line, people keep texting the OLD per-workspace work number of a
 * workspace that moved. Two things happen (docs/agents/one-number.md § Old numbers after the switch):
 *   1. The text is routed as if it had arrived on the shared line (the route does that), so nothing is lost.
 *   2. The sender is told once per 30 days: "We've moved to (XXX) XXX-XXXX. Save this number."
 * Both the auto-reply and the one-time cutover notices are PropLane's cost, never the workspace's: they
 * leave from the shared number as platform sends (`sendPlatformLeadText`, purpose `platform_lead`).
 * The marker is one row per phone in `sms_moved_notices`.
 */
export const MOVED_REPLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MOVED_SWEEP_BATCH = 100;

export function movedNoticeText(sharedNumber: string): string {
  return toGsm7(`We've moved to ${formatUsPhoneDisplay(sharedNumber)}. Save this number.`);
}

/**
 * Is this text on an OLD work number of a workspace that now answers on the shared line? Shared mode,
 * the number is not the shared one, it belongs to a workspace, and that workspace is on the shared line
 * (not dedicated: a dedicated workspace keeps its number and behaves exactly as today).
 */
export function isOldNumberOnSharedLine(config: SharedLineConfig, toPhone: string, owned: { workspaceId: string | null } | null): boolean {
  if (config.mode !== "shared" || !config.sharedNumber) return false;
  if (isSharedLineNumber(config, toPhone)) return false;
  return Boolean(owned?.workspaceId) && workspaceOnSharedLine(config, owned!.workspaceId);
}

type Send = (db: SupabaseClient, input: { to: string; body: string; now?: Date; inboundReply?: boolean }) => Promise<PlatformLeadSendResult>;
type Row = Record<string, unknown>;

export type MovedReplyResult = "sent" | "already_told" | "unavailable" | "send_failed";

/**
 * Tell this sender where we moved, at most once per 30 days. The marker is claimed BEFORE the send (two
 * overlapping texts cannot both reply) and handed back when the text did not go out.
 */
export async function sendMovedAutoReply(
  db: SupabaseClient,
  input: { config: SharedLineConfig; phoneKey: string; fromPhone: string; workspaceId: string; messageSid: string; now?: Date; send?: Send },
): Promise<MovedReplyResult> {
  const sharedNumber = input.config.sharedNumber;
  if (!sharedNumber) return "unavailable";
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - MOVED_REPLY_WINDOW_MS).toISOString();
  const claimed = { source: "auto_reply", status: "sent", notified_at: nowIso, available_at: nowIso, message_sid: input.messageSid, updated_at: nowIso };

  let previous: Row | null = null;
  const inserted = await db.from("sms_moved_notices").insert({ phone_key: input.phoneKey, workspace_id: input.workspaceId, ...claimed });
  if (inserted.error) {
    if (isMissingSchemaError(inserted.error)) return "unavailable";
    if (inserted.error.code !== "23505") return "unavailable";
    const existing = await db.from("sms_moved_notices").select("phone_key, source, status, notified_at, available_at, message_sid, workspace_id").eq("phone_key", input.phoneKey).maybeSingle();
    if (existing.error || !existing.data) return "unavailable";
    previous = existing.data as Row;
    // Take the row only while it is still a queued cutover notice or a notice older than 30 days.
    const base = db.from("sms_moved_notices").update({ ...claimed, workspace_id: input.workspaceId }).eq("phone_key", input.phoneKey);
    const took = previous.status === "queued"
      ? await base.eq("status", "queued").select("phone_key")
      : await base.eq("status", "sent").lt("notified_at", cutoff).select("phone_key");
    if (took.error) return "unavailable";
    if (!took.data?.length) return "already_told";
  }

  const send = input.send ?? sendPlatformLeadText;
  const result = await send(db, { to: input.fromPhone, body: movedNoticeText(sharedNumber), now, inboundReply: true }).catch(() => ({ ok: false as const, reason: "provider_error" as const }));
  if (result.ok) return "sent";
  // Opted out / shielded is final for this sender (the marker stays); anything else is handed back.
  if (result.reason === "opted_out" || result.reason === "shielded") return "send_failed";
  if (previous) {
    await db.from("sms_moved_notices").update({ source: previous.source, status: previous.status, notified_at: previous.notified_at, available_at: previous.available_at, message_sid: previous.message_sid, updated_at: nowIso }).eq("phone_key", input.phoneKey).eq("message_sid", input.messageSid);
  } else {
    await db.from("sms_moved_notices").delete().eq("phone_key", input.phoneKey).eq("message_sid", input.messageSid);
  }
  return "send_failed";
}

export type MovedQueueSummary = { due: number; sent: number; retry: number; skipped?: "not_shared_mode" | "quiet_hours" | "unavailable" };

/**
 * The platform dispatcher for the one-time cutover notices `cutover.mjs --notify-moved` queues in
 * `sms_moved_notices`. Runs from the cron; shared mode and daytime only. Each row is claimed (queued ->
 * sent) before its text goes, and put back when the provider failed, so a second sweep cannot double-send.
 */
export async function runMovedNoticeQueue(
  db: SupabaseClient,
  deps: { now?: () => Date; send?: Send; loadConfig?: (db: SupabaseClient) => Promise<SharedLineConfig> } = {},
): Promise<MovedQueueSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: MovedQueueSummary = { due: 0, sent: 0, retry: 0 };
  const config = await (deps.loadConfig ?? loadSharedLineConfig)(db);
  if (config.mode !== "shared" || !config.sharedNumber) return { ...summary, skipped: "not_shared_mode" };
  if (quietHoursBlocks("automated", now())) return { ...summary, skipped: "quiet_hours" };
  const due = await db.from("sms_moved_notices").select("phone_key").eq("status", "queued").lte("available_at", now().toISOString()).order("available_at", { ascending: true }).limit(MOVED_SWEEP_BATCH);
  if (due.error) return { ...summary, skipped: "unavailable" };
  const send = deps.send ?? sendPlatformLeadText;
  const text = movedNoticeText(config.sharedNumber);
  for (const row of (due.data ?? []) as Row[]) {
    const phoneKey = String(row.phone_key ?? "");
    if (!phoneKey) continue;
    summary.due += 1;
    const at = now().toISOString();
    const taken = await db.from("sms_moved_notices").update({ status: "sent", notified_at: at, updated_at: at }).eq("phone_key", phoneKey).eq("status", "queued").select("phone_key");
    if (taken.error || !taken.data?.length) continue;
    const result = await send(db, { to: e164FromPhoneKey(phoneKey), body: text, now: now() }).catch(() => ({ ok: false as const, reason: "provider_error" as const }));
    if (result.ok || result.reason === "opted_out" || result.reason === "shielded" || result.reason === "invalid_to") {
      if (result.ok) summary.sent += 1;
      continue;
    }
    await db.from("sms_moved_notices").update({ status: "queued", notified_at: null, updated_at: at }).eq("phone_key", phoneKey).eq("status", "sent");
    summary.retry += 1;
    if (result.reason === "quiet_hours") break;
  }
  return summary;
}
