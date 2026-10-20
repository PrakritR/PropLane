import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { loadSharedLineConfig, workspaceOnSharedLine as workspaceOnSharedLineConfig } from "@/lib/one-number/config.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { dispatchOwnerSmsOutbox, enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { TEAM_NOTICE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { memberPhoneEligibility } from "@/lib/team-comms.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { rosterSenderFor, serviceOwnerForWorkspace } from "@/lib/vendor-dispatch/service-roster.server";
import { toGsm7 } from "@/lib/vendor-dispatch/text";
import {
  VENDOR_CONVERSATION_PURPOSE,
  buildVendorSenderLine,
  carryVendorConsentToKey,
  readVendorTextConsent,
  recordManagerAttestedVendorConsent,
} from "@/lib/sms/vendor-conversation-consent.server";

/**
 * Every outbound text of the dispatch engine goes through these four doors, so the
 * engine's tests mock one module and the transport rules stay in one place
 * (vendor-dispatch-1018). A failed send is a value, never a throw: the caller
 * decides whether to advance the chain, retry on the next sweep, or alert.
 */

export type DispatchSendResult = { ok: true; outboxId: string | null } | { ok: false; reason: string };

/** Is this workspace answering on the one shared line? Same decision as the transport (`config.server.ts`). */
export async function workspaceOnSharedLine(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  return workspaceOnSharedLineConfig(await loadSharedLineConfig(db), workspaceId);
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
 * A service workspace's own (non-roster) vendor with no work number to text from: send AS the service owner on the PropLane
 * line, under the service owner's vendor consent ledger (so the vendor's STOP and replies live there, exactly like a
 * roster vendor). Returns null when this does not apply (not a service workspace, or the workspace has a line of its own):
 * the caller then uses the workspace's own path. A STOP is final. The approval of the run, by the service manager, is the
 * relationship attestation; the first text carries the sender line and "Reply STOP to opt out".
 */
async function sendOwnVendorViaServiceLine(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; vendorDirectoryId: string; phone: string; vendorUserId?: string | null; text: string; idempotencyKey: string },
): Promise<DispatchSendResult | null> {
  const serviceOwnerId = await serviceOwnerForWorkspace(db, input.workspaceId);
  if (!serviceOwnerId) return null;
  const ownLine = await resolveWorkspaceSendLine(db, input.ownerUserId, input.workspaceId).catch(() => null);
  if (ownLine) return null;

  const vendorUserId = input.vendorUserId ?? null;
  const consent = await readVendorTextConsent(db, { managerUserId: serviceOwnerId, vendorUserId, phone: input.phone }).catch(() => null);
  if (!consent?.ok) return { ok: false, reason: "consent_unavailable" };
  if (consent.state === "opted_out" || consent.state === "revoked") return { ok: false, reason: "recipient_opted_out" };

  let text = input.text;
  if (consent.state === "none") {
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", serviceOwnerId).maybeSingle();
    const senderLine = buildVendorSenderLine({
      managerFirstName: String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim().split(/\s+/)[0] || null,
      workspaceName: "PropLane",
    });
    const recorded = await recordManagerAttestedVendorConsent(db, {
      managerUserId: serviceOwnerId,
      actorUserId: serviceOwnerId,
      phone: input.phone,
      conversationKey: consent.conversationKey,
      vendorRecordId: input.vendorDirectoryId,
      senderLine,
    });
    if (!recorded.ok) return { ok: false, reason: "consent_unavailable" };
    text = `${text} ${senderLine}`;
  } else if (consent.grantedUnder && consent.grantedUnder !== consent.conversationKey) {
    const carried = await carryVendorConsentToKey(db, { managerUserId: serviceOwnerId, phone: input.phone, conversationKey: consent.conversationKey, fromKey: consent.grantedUnder });
    if (!carried.ok) return { ok: false, reason: "consent_unavailable" };
  }

  const ownerWorkspaceId = await userDefaultWorkspaceId(db, serviceOwnerId);
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const sent = await sendFromManagerWorkNumber({
    managerUserId: serviceOwnerId,
    workspaceId: ownerWorkspaceId || null,
    to: input.phone,
    text,
    source: "automated",
    sendClass: "transactional",
    purpose: VENDOR_CONVERSATION_PURPOSE,
    counterpartyRole: "vendor",
    conversationKey: consent.conversationKey,
    ...(vendorUserId ? { recipientUserId: vendorUserId } : {}),
    dedupeKey: input.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(16, "_").slice(0, 128),
  });
  if (sent.ok || sent.durablyAccepted) return { ok: true, outboxId: typeof sent.outboxId === "string" ? sent.outboxId : null };
  return { ok: false, reason: sent.error ?? "send_failed" };
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

  // A PropLane Service roster vendor belongs to the service owner: the text leaves from the PropLane line as the
  // service owner, under their consent ledger (where the vendor's STOP and replies live).
  const rosterSender = await rosterSenderFor(db, input.vendorDirectoryId);
  if (rosterSender) {
    const ownerWorkspaceId = await userDefaultWorkspaceId(db, rosterSender.serviceOwnerId);
    const sent = await sendManagerConversationSms(db, {
      actorUserId: rosterSender.serviceOwnerId,
      idempotencyKey: input.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(16, "_").slice(0, 128),
      toPhone: phone,
      text,
      vendorRecordId: input.vendorDirectoryId,
      attestVendorRelationship: true,
      workspace: { id: ownerWorkspaceId || null },
    });
    if (sent.status >= 200 && sent.status < 300 && !sent.body.error) {
      return { ok: true, outboxId: typeof sent.body.outboxId === "string" ? sent.body.outboxId : null };
    }
    return { ok: false, reason: String(sent.body.error ?? sent.body.code ?? `status_${sent.status}`) };
  }

  // A PropLane Service workspace's OWN vendor, when the workspace has no attached work number of its own: the text leaves
  // from the PropLane line (the service owner's number). The workspace's own line, when it has one, still wins.
  const viaServiceLine = await sendOwnVendorViaServiceLine(db, { ...input, phone, text });
  if (viaServiceLine) return viaServiceLine;

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
  // The service manager of a PropLane Service workspace is texted at the verified manager phone from the PropLane line
  // (`platform_service_settings`), never at a profile phone: several profiles can share that number.
  const serviceOwnerId = await serviceOwnerForWorkspace(db, input.workspaceId);
  if (serviceOwnerId && serviceOwnerId === input.memberUserId) {
    const { sendToServiceManager } = await import("@/lib/service/service-manager.server");
    const sent = await sendToServiceManager(db, { text, dedupeKey: input.dedupeKey });
    return sent.ok ? { ok: true, outboxId: null } : { ok: false, reason: sent.reason };
  }
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
