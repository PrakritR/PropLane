import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { dispatchOwnerSmsOutbox, enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { TEAM_NOTICE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { memberPhoneEligibility } from "@/lib/team-comms.server";
import { toGsm7 } from "@/lib/vendor-dispatch/text";

/**
 * Every outbound text of the dispatch engine goes through these four doors, so the
 * engine's tests mock one module and the transport rules stay in one place
 * (vendor-dispatch-1018). A failed send is a value, never a throw: the caller
 * decides whether to advance the chain, retry on the next sweep, or alert.
 */

export type DispatchSendResult = { ok: true; outboxId: string | null } | { ok: false; reason: string };

/** Is this workspace answering on the one shared line? (`sms_runtime_config.line_mode`) */
export async function workspaceOnSharedLine(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("sms_runtime_config")
      .select("line_mode, shared_pilot_workspace_ids")
      .eq("singleton", true)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { line_mode?: string; shared_pilot_workspace_ids?: string[] | null };
    if (row.line_mode !== "shared") return false;
    const pilot = row.shared_pilot_workspace_ids ?? [];
    return pilot.length === 0 || pilot.includes(workspaceId);
  } catch {
    return false;
  }
}

async function enqueueAndDispatch(
  db: SupabaseClient,
  input: Parameters<typeof enqueueOwnerSms>[0],
): Promise<DispatchSendResult> {
  const queued = await enqueueOwnerSms(input, db).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "send_failed",
  }));
  if (!queued.ok) return { ok: false, reason: queued.error };
  if (!queued.deduplicated) {
    await dispatchOwnerSmsOutbox({ workerId: `dispatch-${randomUUID()}`, outboxId: queued.outboxId }, db).catch(() => undefined);
  }
  const { data: outbox } = await db.from("sms_outbox").select("status, blocked_reason").eq("id", queued.outboxId).maybeSingle();
  const status = String((outbox as { status?: unknown } | null)?.status ?? queued.status);
  if (["blocked", "failed", "canceled", "cancelled"].includes(status)) {
    return { ok: false, reason: String((outbox as { blocked_reason?: unknown } | null)?.blocked_reason ?? status) };
  }
  return { ok: true, outboxId: queued.outboxId };
}

/**
 * Text one vendor an offer or a follow-up. The roster row's own saved phone is the
 * destination; the manager's first-text attestation and the sender/STOP line ride
 * the existing roster-vendor path. `actorUserId` is the workspace owner: the
 * approving person was authorized before this runs.
 */
export async function sendVendorDispatchText(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string;
    vendorDirectoryId: string;
    phone: string;
    vendorUserId?: string | null;
    text: string;
    idempotencyKey: string;
  },
): Promise<DispatchSendResult> {
  const text = toGsm7(input.text);
  if (!text) return { ok: false, reason: "empty" };
  const phone = normalizeE164(input.phone);
  if (!phone) return { ok: false, reason: "no_phone" };

  if (await workspaceOnSharedLine(db, input.workspaceId)) {
    const sent = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      toPhone: phone,
      body: text,
      role: "vendor",
      idempotencyKey: input.idempotencyKey,
    });
    if (sent.ok) return { ok: true, outboxId: null };
    // not_shared_mode: the line is not live yet, so fall through to the per-workspace number.
    if (sent.reason !== "not_shared_mode") return { ok: false, reason: sent.reason };
  }

  const key = /^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)
    ? input.idempotencyKey
    : input.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(16, "_").slice(0, 128);
  const result = await sendManagerConversationSms(db, {
    actorUserId: input.ownerUserId,
    idempotencyKey: key,
    toPhone: phone,
    text,
    vendorRecordId: input.vendorDirectoryId,
    // Approving this dispatch is the manager naming this vendor for this job.
    attestVendorRelationship: true,
    workspace: { id: input.workspaceId },
  });
  if (result.status >= 200 && result.status < 300 && !result.body.error) {
    return { ok: true, outboxId: typeof result.body.outboxId === "string" ? result.body.outboxId : null };
  }
  return { ok: false, reason: String(result.body.error ?? result.body.code ?? `status_${result.status}`) };
}

/** Text one member of the workspace team (the owner or a teammate) at their own verified phone. */
export async function sendTeamMemberDispatchText(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    memberUserId: string;
    propertyId?: string | null;
    text: string;
    dedupeKey: string;
  },
): Promise<DispatchSendResult> {
  const text = toGsm7(input.text);
  if (!text) return { ok: false, reason: "empty" };
  const eligibility = await memberPhoneEligibility(db, input.memberUserId);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  const line = await resolveWorkspaceSendLine(db, input.ownerUserId, input.workspaceId).catch(() => null);

  if (input.workspaceId && (await workspaceOnSharedLine(db, input.workspaceId))) {
    const sent = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      toPhone: eligibility.phone,
      body: text,
      role: "manager",
      idempotencyKey: input.dedupeKey,
    });
    if (sent.ok) return { ok: true, outboxId: null };
    if (sent.reason !== "not_shared_mode") return { ok: false, reason: sent.reason };
  }
  if (!line) return { ok: false, reason: "no_work_number" };

  return enqueueAndDispatch(db, {
    managerUserId: input.ownerUserId,
    actorUserId: input.ownerUserId,
    selectedWorkLineId: line.numberId,
    recipientPhone: eligibility.phone,
    recipientUserId: input.memberUserId,
    body: text,
    sendClass: "transactional",
    purpose: TEAM_NOTICE_SMS_PURPOSE,
    counterpartyRole: "manager",
    propertyId: input.propertyId ?? undefined,
    suppressConversationLog: true,
    dedupeKey: input.dedupeKey,
  });
}

/** Text a resident about their own service. A resident with no verified phone on file is simply not texted. */
export async function sendResidentDispatchText(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    residentEmail: string;
    text: string;
    dedupeKey: string;
  },
): Promise<DispatchSendResult> {
  const text = toGsm7(input.text);
  const email = input.residentEmail.trim().toLowerCase();
  if (!text || !email.includes("@")) return { ok: false, reason: "no_resident" };
  const { data: profile } = await db
    .from("profiles")
    .select("id, phone, phone_verified_at")
    .eq("email", email)
    .maybeSingle();
  const row = profile as { id?: string; phone?: string | null; phone_verified_at?: string | null } | null;
  const phone = normalizeE164(String(row?.phone ?? ""));
  if (!row?.id || !phone || !row.phone_verified_at) return { ok: false, reason: "no_verified_phone" };

  if (input.workspaceId && (await workspaceOnSharedLine(db, input.workspaceId))) {
    const sent = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      toPhone: phone,
      body: text,
      role: "resident",
      idempotencyKey: input.dedupeKey,
    });
    if (sent.ok) return { ok: true, outboxId: null };
    if (sent.reason !== "not_shared_mode") return { ok: false, reason: sent.reason };
  }
  const { deliverResidentSmsReply } = await import("@/lib/agent/resident-sms-agent.server");
  const result = await deliverResidentSmsReply({
    ownerManagerUserId: input.ownerUserId,
    residentUserId: row.id,
    toPhone: phone,
    text,
    inboundMessageSid: input.dedupeKey,
  }).catch(() => null);
  return result?.ok ? { ok: true, outboxId: null } : { ok: false, reason: result?.error ?? "send_failed" };
}
