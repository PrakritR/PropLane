import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryIssueInput } from "@/lib/prospect-spine/contracts";
import { mergeThreadRowData, readThread } from "@/lib/prospect-spine/thread.server";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Scrub a reason to a sentence a person can read: no phone numbers, no ids, no long digit runs. */
function cleanReason(reason: string): string {
  return reason
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Stamp `row_data.deliveryIssue = { at, direction, reason, messageId }` on the thread so the inbox shows it (the Filter's
 * "Delivery issues" and the failed bubble's "Not sent" line). With no thread (an inbound that never routed) it raises ONE
 * Attention item for the platform service owner instead. NEVER throws: it runs on failure paths.
 */
export async function recordDeliveryIssue(db: SupabaseClient, input: DeliveryIssueInput): Promise<void> {
  try {
    const reason = cleanReason(input.reason) || "A message could not be delivered.";
    const threadId = str(input.threadId);
    if (threadId) {
      const thread = await readThread(db, threadId);
      if (thread?.ownerUserId) {
        const written = await mergeThreadRowData(db, {
          threadId,
          ownerUserId: thread.ownerUserId,
          patch: {
            deliveryIssue: {
              at: new Date().toISOString(),
              direction: input.direction,
              reason,
              ...(str(input.messageId) ? { messageId: str(input.messageId) } : {}),
            },
            unread: true,
          },
        });
        if (written) return;
      }
    }
    const { serviceAlertPayerUserId } = await import("@/lib/service/service-alert-targets.server");
    const owner = await serviceAlertPayerUserId(db);
    if (!owner) return;
    const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
    await notifyManagerFromAgent(db, {
      landlordId: owner,
      subject: input.direction === "inbound" ? "A text did not reach the inbox" : "A reply was not delivered",
      text: reason,
      threadType: "attention",
      category: "messages",
      notify: { push: true, sms: false },
      idempotencyKey: `delivery-issue:${str(input.eventId).slice(0, 120)}`,
      url: "/admin/service",
    });
  } catch {
    console.error("delivery issue not recorded");
  }
}

/** A later delivered send clears the thread's issue. Never throws. */
export async function clearDeliveryIssue(db: SupabaseClient, threadId: string): Promise<void> {
  try {
    const id = str(threadId);
    if (!id) return;
    const thread = await readThread(db, id);
    if (!thread?.ownerUserId || !thread.rowData.deliveryIssue) return;
    await mergeThreadRowData(db, { threadId: id, ownerUserId: thread.ownerUserId, remove: ["deliveryIssue"] });
  } catch {
    /* advisory */
  }
}

/** What a person on the platform can read for each way an inbound envelope ends in review. No ids, no numbers. */
const ENVELOPE_REASON_TEXT: Record<string, string> = {
  delivery_unknown: "A reply to a text may not have been delivered: the carrier did not confirm it.",
  reply_blocked: "A reply to a text could not be sent (the sender is blocked or the line is not ready).",
  sid_conflict: "A reply to a text could not be matched to the carrier's record.",
  uncertain_effect: "A text arrived but PropLane could not tell whether it was fully handled.",
  delegated_receipt: "A text arrived and its reply is waiting for a person to check it.",
  retry_exhausted: "A text arrived but PropLane could not process it after several tries.",
};

/** What the thread says about a parked text: it is there, and nobody has answered it. */
export const PARKED_INBOUND_REASON = "Not answered yet";

const PARKED_ROLES = new Set(["prospect", "applicant"]);

type ParkedText = { from: string; body: string; sid: string; receivedAt: string };
type SurfacedThread = { threadId: string; workspaceId: string; ownerUserId: string };

async function readParkedText(db: SupabaseClient, envelopeId: string): Promise<(ParkedText & { to: string }) | null> {
  const { data } = await db
    .from("sms_ingress_envelopes")
    .select("wire_from, wire_to, message_sid, received_at, params, status")
    .eq("id", envelopeId)
    .maybeSingle();
  if (!data || data.status !== "needs_review") return null;
  const params = (data.params ?? {}) as Record<string, unknown>;
  const from = str(data.wire_from);
  const sid = str(data.message_sid);
  if (!from || !sid) return null;
  return { from, to: str(data.wire_to), body: str(params.Body), sid, receivedAt: str(data.received_at) || new Date().toISOString() };
}

/**
 * The ONE workspace a parked text certainly belongs to, as the person's prospect thread — or null. Certain means: the
 * number it was sent to is a workspace's own live number and this phone already has a prospect conversation there, or it
 * was sent to the shared line and the phone's session names one workspace in a prospect role with no question pending.
 * Anything else (a resident, a manager, an open "which home?") is never guessed into a thread.
 */
async function parkedTextWorkspace(db: SupabaseClient, text: ParkedText & { to: string }): Promise<string | null> {
  const { normalizeConsentPhone, profilePhoneVariants } = await import("@/lib/sms-consent");
  const { data: lines } = await db
    .from("manager_sms_numbers")
    .select("workspace_id, provision_state")
    .eq("phone_number", text.to)
    .is("released_at", null)
    .limit(2);
  const live = (lines ?? []).filter((l) => str(l.provision_state) === "active" && str(l.workspace_id));
  if (live.length === 1) {
    const workspaceId = str(live[0]!.workspace_id);
    const { data: convo } = await db
      .from("sms_projection_conversations")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("counterparty_phone", profilePhoneVariants(text.from))
      .in("counterparty_role", [...PARKED_ROLES])
      .is("merged_into_id", null)
      .limit(1);
    return (convo ?? []).length ? workspaceId : null;
  }
  if (live.length > 1) return null;
  const phoneKey = normalizeConsentPhone(text.from);
  if (!phoneKey) return null;
  const { loadSharedLineSession } = await import("@/lib/one-number/session.server");
  const session = await loadSharedLineSession(db, phoneKey);
  if (!session?.currentWorkspaceId || !session.activeRole || !PARKED_ROLES.has(session.activeRole)) return null;
  if (session.pendingCandidates?.length) return null;
  return session.currentWorkspaceId;
}

/**
 * Write a parked text into the person's own thread through the one writer, keyed on the carrier's message id (the same
 * key the normal path uses, so a text that already landed is not added twice). Null when no thread is certain.
 */
async function surfaceParkedText(db: SupabaseClient, text: ParkedText & { to: string }): Promise<SurfacedThread | null> {
  const workspaceId = await parkedTextWorkspace(db, text);
  if (!workspaceId) return null;
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  const ownerUserId = str(ws?.owner_user_id);
  if (!ownerUserId) return null;
  const { normalizeE164 } = await import("@/lib/phone-e164");
  const phoneE164 = normalizeE164(text.from);
  if (!phoneE164) return null;
  const { resolveInboundContext } = await import("@/lib/prospect-spine/context.server");
  const { recordInbound } = await import("@/lib/prospect-spine/record.server");
  const context = await resolveInboundContext(db, { workspaceId, ownerUserId, phoneE164, body: text.body });
  const written = await recordInbound(db, {
    workspaceId,
    ownerUserId,
    identity: { kind: "phone", phoneE164, verified: false },
    context,
    body: text.body || "(empty message)",
    channel: "sms",
    eventId: text.sid,
    occurredAt: text.receivedAt,
    notify: false,
  });
  return written.ok ? { threadId: written.threadId, workspaceId, ownerUserId } : null;
}

/** "Is room 8 open?" as a short quote, for the person the alert reaches. */
function quoteOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return `"${flat.length > 160 ? `${flat.slice(0, 157)}…` : flat}"`;
}

/**
 * An inbound envelope ended `needs_review`. A parked TEXT is never invisible: when its thread is certain it is written
 * there, marked "Not answered yet", and the workspace owner gets one notice that quotes it; otherwise ONE Attention item
 * for the platform service owner quotes it with the sender's last four digits. The automatic reply stays off either way
 * (it may already have gone out). Idempotent on the envelope. Never throws.
 */
export async function reportEnvelopeIssue(db: SupabaseClient, envelopeId: string, reason: string): Promise<void> {
  const eventId = `envelope:${str(envelopeId)}:${str(reason)}`;
  const base = ENVELOPE_REASON_TEXT[reason] ?? "A text could not be fully handled and needs a person to check it.";
  let text: (ParkedText & { to: string }) | null = null;
  try {
    // Only an inbound that may not have been handled is a text a person must see; a reply-side reason keeps its line.
    if (reason === "uncertain_effect" || reason === "retry_exhausted") text = await readParkedText(db, str(envelopeId));
    const surfaced = text ? await surfaceParkedText(db, text) : null;
    if (text && surfaced) {
      await recordDeliveryIssue(db, { threadId: surfaced.threadId, workspaceId: surfaced.workspaceId, direction: "inbound", reason: PARKED_INBOUND_REASON, eventId });
      const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
      await notifyManagerFromAgent(db, {
        landlordId: surfaced.ownerUserId,
        subject: "A text needs a reply",
        text: `A text from ···${text.from.slice(-4)} was not answered automatically: ${quoteOf(text.body)} It is in their conversation in Communication.`,
        threadType: "attention",
        category: "messages",
        notify: { push: true, sms: false },
        idempotencyKey: `parked-text:${eventId}`.slice(0, 160),
        url: "/portal/communication/active",
      });
      return;
    }
  } catch {
    console.error("parked text not surfaced");
  }
  const quoted = text ? `A text was not answered automatically. From ···${text.from.slice(-4)}: ${quoteOf(text.body)}` : base;
  await recordDeliveryIssue(db, { threadId: null, workspaceId: null, direction: "inbound", reason: quoted, eventId });
}
