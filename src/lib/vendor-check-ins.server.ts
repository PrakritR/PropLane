import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { resolveManagerAssistantWorkspace, userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import {
  CHECK_IN_SEND_GRACE_HOURS,
  appendCheckInSend,
  attachCheckInReply,
  checkInDedupeKey,
  checkInRuleOutcome,
  checkInSendAtMs,
  checkInSendDates,
  classifyCheckInReplyIntent,
  isOptOutText,
  normalizeVendorCheckIns,
  renderCheckInQuestion,
  type VendorCheckIn,
} from "@/lib/vendor-check-ins";

/**
 * Vendor check-ins, the server half (`vendor-check-ins.ts` is the pure half): a question on a cadence ("the 1st and
 * 14th: when are you coming next?") texted to a vendor from the workspace's own line, the reply landing in the
 * vendor's Communication thread, and pay or schedule-change replies escalated to the owner.
 *
 * The vendor's name, phone and rate are CONFIG: the vendor record (`manager_vendor_records.row_data`) and its
 * `checkIns` list. Nothing here names a person. The send is the dispatch engine's own text door
 * (`sendVendorDispatchText`): the workspace's line (the PropLane line for a managed workspace), the vendor's
 * consent ledger, STOP honored, one idempotency key per (vendor, check-in, Pacific date). Texts only: the repo
 * has no WhatsApp sender, and none is invented here.
 */

type VendorRecord = { id: string; manager_user_id: string; updated_at: string | null; row_data: Record<string, unknown> };

const PAGE = 500;
const CAS_ATTEMPTS = 3;

function rowCheckIns(row: VendorRecord["row_data"]): VendorCheckIn[] {
  return normalizeVendorCheckIns(row.checkIns);
}

async function loadVendorRecords(db: SupabaseClient, filter: { ownerUserId?: string }): Promise<VendorRecord[]> {
  const out: VendorRecord[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from("manager_vendor_records")
      .select("id, manager_user_id, updated_at, row_data")
      .not("row_data->checkIns", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (filter.ownerUserId) q = q.eq("manager_user_id", filter.ownerUserId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as VendorRecord[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** Compare-and-set the vendor row's `checkIns`: re-read, apply, write guarded on `updated_at`, retry on a lost race. */
async function mutateCheckIns(
  db: SupabaseClient,
  record: Pick<VendorRecord, "id" | "manager_user_id">,
  mutate: (checkIns: VendorCheckIn[]) => VendorCheckIn[] | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("manager_vendor_records")
      .select("id, manager_user_id, updated_at, row_data")
      .eq("id", record.id)
      .eq("manager_user_id", record.manager_user_id)
      .maybeSingle();
    if (error || !data) return false;
    const fresh = data as VendorRecord;
    const next = mutate(rowCheckIns(fresh.row_data));
    if (!next) return true; // nothing to change
    let update = db
      .from("manager_vendor_records")
      .update({ row_data: { ...fresh.row_data, checkIns: next }, updated_at: new Date().toISOString() })
      .eq("id", record.id)
      .eq("manager_user_id", record.manager_user_id);
    update = fresh.updated_at ? update.eq("updated_at", fresh.updated_at) : update;
    const { data: written, error: writeError } = await update.select("id");
    if (writeError) return false;
    if ((written ?? []).length > 0) return true;
  }
  return false;
}

function vendorCallName(row: VendorRecord["row_data"]): string {
  const preferred = typeof row.preferredName === "string" ? row.preferredName.trim() : "";
  if (preferred) return preferred;
  return String(row.name ?? "").trim().split(/\s+/)[0] ?? "";
}

async function sendWorkspaceFor(db: SupabaseClient, ownerUserId: string, propertyId: string | null): Promise<string> {
  const resolved = await resolveManagerAssistantWorkspace(db, ownerUserId, { propertyId }).catch(() => null);
  return resolved?.workspaceId || (await userDefaultWorkspaceId(db, ownerUserId).catch(() => "")) || "";
}

export type CheckInSweepSummary = { vendors: number; due: number; sent: number; failed: number; rules: number; errors: string[] };

/**
 * One tick: send every check-in whose fire time has come (within the grace window) and was not already sent, then
 * evaluate the "no / no reply" rule on earlier sends. Idempotent on (vendor, check-in, Pacific date).
 */
export async function sweepVendorCheckIns(db: SupabaseClient, now: Date = new Date()): Promise<CheckInSweepSummary> {
  const summary: CheckInSweepSummary = { vendors: 0, due: 0, sent: 0, failed: 0, rules: 0, errors: [] };
  const nowMs = now.getTime();
  const today = pacificCalendarDateYmd(nowMs);
  for (const record of await loadVendorRecords(db, {})) {
    const checkIns = rowCheckIns(record.row_data).filter((c) => c.enabled);
    if (checkIns.length === 0) continue;
    summary.vendors += 1;
    const owner = record.manager_user_id;
    const vendorName = vendorCallName(record.row_data);
    for (const checkIn of checkIns) {
      try {
        // 1. A send whose fire time has come.
        if (checkInSendDates(checkIn, today, 1).includes(today)) {
          const at = checkInSendAtMs(checkIn, today);
          const key = checkInDedupeKey(record.id, checkIn.id, today);
          const late = nowMs - at;
          if (nowMs >= at && late <= CHECK_IN_SEND_GRACE_HOURS * 3_600_000 && !checkIn.log.some((e) => e.reminderId === key)) {
            summary.due += 1;
            const phone = normalizeE164(String(record.row_data.phone ?? ""));
            let failure: string | undefined;
            if (!phone) failure = "no_phone";
            else {
              const propertyIds = Array.isArray(record.row_data.propertyIds) ? (record.row_data.propertyIds as string[]) : [];
              const propertyId = checkIn.propertyId ?? propertyIds[0] ?? null;
              const sent = await sendVendorDispatchText(db, {
                ownerUserId: owner,
                workspaceId: await sendWorkspaceFor(db, owner, propertyId),
                vendorDirectoryId: record.id,
                phone,
                vendorUserId: typeof record.row_data.vendorUserId === "string" ? record.row_data.vendorUserId : null,
                approvedByUserId: owner,
                text: renderCheckInQuestion(checkIn.question, { vendor: vendorName }),
                idempotencyKey: key,
              });
              if (!sent.ok) failure = sent.reason || "send_failed";
            }
            const stamp = new Date(nowMs).toISOString();
            await mutateCheckIns(db, record, (list) =>
              list.map((c) =>
                c.id !== checkIn.id || c.log.some((e) => e.reminderId === key)
                  ? c
                  : appendCheckInSend(c, { sentAt: stamp, reminderId: key, channel: "sms", ...(failure ? { failure, ruleRanAt: stamp } : {}) }),
              ),
            );
            if (failure) summary.failed += 1;
            else summary.sent += 1;
          }
        }
        // 2. The "no / no reply" rule on earlier sends.
        for (const entry of checkIn.log) {
          const outcome = checkInRuleOutcome(entry, nowMs);
          if (!outcome || entry.failure) continue;
          summary.rules += 1;
          if (checkIn.onNoOrSilent !== "log") {
            await notifyManagerFromAgent(db, {
              landlordId: owner,
              subject: outcome === "no" ? `${vendorName || "A vendor"} said no` : `No reply from ${vendorName || "a vendor"}`,
              text:
                outcome === "no"
                  ? `${vendorName || "A vendor"} answered "no" to: "${checkIn.question}"${entry.reply?.text ? ` Their reply: "${entry.reply.text}"` : ""}`
                  : `${vendorName || "A vendor"} has not answered: "${checkIn.question}" (sent ${entry.sentAt.slice(0, 10)}).`,
              category: "maintenance",
              idempotencyKey: `vendor-checkin-rule:${record.id}:${checkIn.id}:${entry.sentAt}`,
            }).catch((e: unknown) => summary.errors.push(`notice ${record.id}: ${e instanceof Error ? e.message : "failed"}`));
          }
          await mutateCheckIns(db, record, (list) =>
            list.map((c) =>
              c.id !== checkIn.id
                ? c
                : { ...c, log: c.log.map((e) => (e.sentAt === entry.sentAt && !e.ruleRanAt ? { ...e, ruleRanAt: new Date(nowMs).toISOString() } : e)) },
            ),
          );
        }
      } catch (e) {
        summary.errors.push(`${record.id}/${checkIn.id}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
  }
  return summary;
}

export type CheckInReplyResult = { handled: false } | { handled: true; vendorUserId: string | null; escalated: boolean };

/**
 * An inbound text from a vendor phone that has an UNANSWERED check-in within its window. The reply is attached to
 * that send (so it shows in the vendor's Communication thread and on the check-in's log), a routine answer gets a
 * short acknowledgement, and a pay or schedule-change message goes to the owner (`notifyManagerFromAgent`, the same
 * notice `escalate_to_manager` writes) with a note to the vendor that the owner will answer. A bare STOP is never an
 * answer. `handled: false` = not ours; the normal router carries on untouched.
 */
export async function handleVendorCheckInReply(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; phoneE164: string; body: string; messageSid: string; now?: Date },
): Promise<CheckInReplyResult> {
  const body = input.body.trim();
  if (!body || isOptOutText(body)) return { handled: false };
  const phone = normalizeE164(input.phoneE164);
  if (!phone) return { handled: false };
  const nowMs = (input.now ?? new Date()).getTime();

  const records = await loadVendorRecords(db, { ownerUserId: input.ownerUserId });
  const record = records.find((r) => {
    if (normalizeE164(String(r.row_data.phone ?? "")) !== phone) return false;
    return rowCheckIns(r.row_data).some((c) => c.log.some((e) => !e.reply && !e.failure && nowMs - Date.parse(e.sentAt) <= 36 * 3_600_000 && nowMs >= Date.parse(e.sentAt)));
  });
  if (!record) return { handled: false };

  const at = new Date(nowMs).toISOString();
  const attachment: { checkIn: VendorCheckIn | null } = { checkIn: null };
  const stored = await mutateCheckIns(db, record, (list) => {
    for (let i = 0; i < list.length; i += 1) {
      const attached = attachCheckInReply(list[i]!, { at, text: body.slice(0, 500) });
      if (attached.attached) {
        attachment.checkIn = attached.checkIn;
        const next = list.slice();
        next[i] = attached.checkIn;
        return next;
      }
    }
    return null;
  });
  const attachedTo = attachment.checkIn;
  if (!stored || !attachedTo) return { handled: false };

  const vendorUserId = typeof record.row_data.vendorUserId === "string" ? record.row_data.vendorUserId : null;
  const name = vendorCallName(record.row_data);
  const intent = classifyCheckInReplyIntent(body);
  const owner = record.manager_user_id;
  const sendTo = async (text: string, suffix: string) =>
    sendVendorDispatchText(db, {
      ownerUserId: owner,
      workspaceId: input.workspaceId ?? (await sendWorkspaceFor(db, owner, null)),
      vendorDirectoryId: record.id,
      phone,
      vendorUserId,
      approvedByUserId: owner,
      text,
      idempotencyKey: `vendor-checkin-${suffix}-${input.messageSid}`,
    }).catch(() => ({ ok: false as const, reason: "send_failed" }));

  if (intent === "escalate") {
    await notifyManagerFromAgent(db, {
      landlordId: owner,
      subject: `${name || "A vendor"} needs you: pay or schedule`,
      text: `${name || "A vendor"} replied to "${attachedTo.question}": "${body.slice(0, 300)}". This is about pay or a schedule change, so it is waiting for you.`,
      category: "maintenance",
      workspaceId: input.workspaceId,
      idempotencyKey: `vendor-checkin-escalate:${input.messageSid}`,
    }).catch((e: unknown) => console.error("check-in escalation notice failed", e instanceof Error ? e.message : "unknown"));
    await sendTo(`Thanks${name ? ` ${name}` : ""}, I have passed that to the owner and they will get back to you.`, "escalate");
    return { handled: true, vendorUserId, escalated: true };
  }
  await sendTo(`Thanks${name ? ` ${name}` : ""}, noted.`, "ack");
  return { handled: true, vendorUserId, escalated: false };
}
