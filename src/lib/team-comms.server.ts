import "server-only";

/**
 * Manager <-> manager "Team" thread (WS5) + its SMS mirror (WS6), PLAN-0915
 * phase 5.
 *
 * Before WS5 there was no manager<->manager messaging at all. This module
 * adds exactly one new kind of `portal_inbox_thread_records` row —
 * `thread_type: "team"` (documented in `docs/agents/communication-inbox.md`
 * and `docs/agents/automated-communication.md`) — that every
 * team-audience action event posts into, attributed "as <acting manager>". It
 * reuses the existing table (additive: `thread_type` is an unconstrained
 * free-text column, see
 * `supabase/migrations/20260428201000_portal_backend_records.sql`) rather
 * than inventing a parallel store, matching "Inbox is the record" (AGENTS.md
 * -> Multi-agent collaboration / communication-inbox.md).
 *
 * Scope: one Team thread per OWNING MANAGER ACCOUNT **per house**
 * (`team-thread:<owner>:<propertyId>`), plus one house-less thread per owner
 * (`team-thread:<owner>`) for notices about nothing in particular. The house
 * is the unit Communication already shares on: `conversationVisible`
 * (`communication/conversation-visibility.server.ts`) shows another owner's
 * conversation to a co-manager only when it is about a house they hold
 * `inbox` on, and never shares a conversation about no house. Stamping the
 * thread's `row_data.propertyId` is what lets the existing list, read and
 * reply gates (`filterVisibleInboxThreadRecords`,
 * `resolveInboxThreadReplyTarget`) admit the right co-managers with no second
 * access model — a co-manager with an empty grant sees nothing, exactly as
 * AGENTS.md § Co-manager access requires.
 *
 * Recipients are deny-by-default per PROPERTY + MODULE
 * (`resolveTeamNoticeRecipientIds`): the owner, plus only the co-managers whose
 * accepted `account_link_invites` row assigns them that house with the event's
 * module (payments, applications, leases, services, calendar) at
 * `notification`. No house means the owner alone. The SMS mirror texts exactly
 * that set; the thread post lands on the house's thread, whose readers are the
 * same house's `inbox` grantees. Nothing here is broader than a module alert.
 *
 * Authorization: `portal_inbox_thread_records` has RLS enabled with ZERO
 * policies for `anon`/`authenticated` (service-role only), so authorization
 * stays in application code — `assertTeamThreadMember` is the gate a route
 * calls before reading or posting into a team thread, and it answers from the
 * same `inbox` grant on the same house the visibility resolver reads.
 *
 * Appends are a compare-and-set on the row's `updated_at` (with a bounded
 * retry, including the insert-conflict path), so two team events landing in
 * the same second — a payment and a tour claim, a durable lease retry racing a
 * live emit — can never lose one another's message to a last-writer-wins
 * upsert.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { asStringArray, INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import {
  hasCoManagerPermissionLevelForProperty,
  type CoManagerPermissionId,
} from "@/lib/co-manager-permissions";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

const TEAM_THREAD_PREFIX = "team-thread:";
const TEAM_THREAD_APPEND_ATTEMPTS = 4;

/** The Teams module that gates who hears a team notice, by the event's domain. */
export type TeamNoticeModule = CoManagerPermissionId;

/** One Team thread per owning manager account and house; house-less notices share the owner's plain thread. */
export function teamThreadId(ownerManagerUserId: string, propertyId?: string | null): string {
  const owner = ownerManagerUserId.trim();
  const property = propertyId?.trim() ?? "";
  return property ? `${TEAM_THREAD_PREFIX}${owner}:${property}` : `${TEAM_THREAD_PREFIX}${owner}`;
}

export function isTeamThreadId(id: string): boolean {
  return id.startsWith(TEAM_THREAD_PREFIX);
}

/** The owner (and house, when the thread is about one) a team-thread id names; `null` for any other id. */
export function parseTeamThreadId(id: string): { ownerManagerUserId: string; propertyId: string | null } | null {
  if (!isTeamThreadId(id)) return null;
  const rest = id.slice(TEAM_THREAD_PREFIX.length);
  const sep = rest.indexOf(":");
  const owner = (sep < 0 ? rest : rest.slice(0, sep)).trim();
  const property = sep < 0 ? "" : rest.slice(sep + 1).trim();
  if (!owner) return null;
  return { ownerManagerUserId: owner, propertyId: property || null };
}

/**
 * Who a team notice about `propertyId` reaches under `module`: the owner, plus
 * every accepted co-manager assigned that house with the module granted at
 * `notification`. No house → the owner alone. Every read failure narrows to
 * the owner — a widened roster is a widened surface for texting a manager
 * about a house they were never granted.
 */
export async function resolveTeamNoticeRecipientIds(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; propertyId?: string | null; module: TeamNoticeModule },
): Promise<string[]> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return [];
  try {
    return await resolvePropertyScopedManagerRecipientIds(
      db as Parameters<typeof resolvePropertyScopedManagerRecipientIds>[0],
      { ownerManagerUserId: ownerId, propertyId: input.propertyId ?? null, channel: input.module },
    );
  } catch {
    return [ownerId];
  }
}

/**
 * May `userId` read (`level: "read"`) or post (`level: "edit"`) this team
 * thread? The owner always; a co-manager only for a house thread, and only
 * when their accepted link assigns them that house with Communication
 * (`inbox`) at that level — the same rule `conversationVisible` lists by.
 * A house-less thread is the owner's alone.
 */
export async function assertTeamThreadMember(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; propertyId?: string | null; userId: string; level?: "read" | "edit" },
): Promise<boolean> {
  const ownerId = input.ownerManagerUserId.trim();
  const userId = input.userId.trim();
  if (!ownerId || !userId) return false;
  if (userId === ownerId) return true;
  const propertyId = input.propertyId?.trim() ?? "";
  if (!propertyId) return false;
  try {
    const { data, error } = await db
      .from("account_link_invites")
      .select(`invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId)
      .eq("invitee_user_id", userId);
    if (error) return false;
    for (const row of data ?? []) {
      if (!asStringArray((row as { assigned_property_ids?: unknown }).assigned_property_ids).includes(propertyId)) continue;
      const perms = readPropertyPermissionsFromRow(row as Parameters<typeof readPropertyPermissionsFromRow>[0]);
      if (hasCoManagerPermissionLevelForProperty(perms, propertyId, "inbox", input.level ?? "read")) return true;
    }
  } catch {
    /* an unreadable grant table shares nothing */
  }
  return false;
}

type TeamThreadMessage = {
  id: string;
  from: string;
  body: string;
  at: string;
  outbound?: boolean;
  actorUserId?: string;
};

type TeamThreadRow = { id: string; row_data: Record<string, unknown> | null; updated_at: string | null };

function teamThreadBase(input: {
  ownerId: string;
  propertyId: string | null;
  propertyTitle?: string;
}): Record<string, unknown> {
  return {
    id: teamThreadId(input.ownerId, input.propertyId),
    scope: MANAGER_INBOX_STORAGE_KEY,
    owner_user_id: input.ownerId,
    participant_email: null,
    thread_type: "team",
  };
}

/**
 * Post one message into the owner's Team thread for `propertyId` (or the
 * house-less one), attributed to the acting manager. Idempotent on
 * `messageId` (the action-event bus's idempotent-per-eventKey contract — a
 * retried delivery must not double-post) and atomic per append (CAS on
 * `updated_at`, retried; an insert that loses to a concurrent creator falls
 * through to the same CAS append).
 */
export async function postTeamThreadMessage(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
    propertyTitle?: string;
    actorUserId?: string;
    actorName: string;
    subject: string;
    text: string;
    smsText?: string;
    messageId: string;
    urgent?: boolean;
    /** A manager approving a queued team draft: the head draft whose text this is gets consumed and the next promoted. */
    consumeDraft?: boolean;
  },
): Promise<{ ok: true; posted: boolean } | { ok: false; error: string }> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return { ok: false, error: "Team thread requires an owning manager." };
  const propertyId = input.propertyId?.trim() || null;
  const threadId = teamThreadId(ownerId, propertyId);
  const actorName = input.actorName.trim() || "PropLane";
  const preview = input.text.slice(0, 100).replace(/\n/g, " ");
  const propertyTitle = input.propertyTitle?.trim() || "";
  const base = teamThreadBase({ ownerId, propertyId, propertyTitle });

  for (let attempt = 0; attempt < TEAM_THREAD_APPEND_ATTEMPTS; attempt += 1) {
    const when = formatPacificDateTime(new Date());
    const updatedAt = new Date().toISOString();
    const { data: existing, error: readError } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .eq("id", threadId)
      .maybeSingle();
    if (readError) return { ok: false, error: "Could not load the team thread." };

    if (!existing) {
      const { error: insertError } = await db.from("portal_inbox_thread_records").insert({
        ...base,
        row_data: {
          id: threadId,
          folder: "inbox",
          from: actorName,
          email: "",
          subject: propertyTitle ? `Team · ${propertyTitle}` : "Team",
          preview,
          body: input.text,
          time: when,
          rootAt: when,
          rootOutbound: true,
          rootActorUserId: input.actorUserId ?? ownerId,
          unread: true,
          scope: MANAGER_INBOX_STORAGE_KEY,
          rootMessageId: input.messageId,
          ...(propertyId ? { propertyId } : {}),
          ...(propertyTitle ? { propertyTitle } : {}),
          messages: [] as TeamThreadMessage[],
        },
        updated_at: updatedAt,
      });
      // No conflict: this call created the thread with this message as its root.
      // A conflict means a concurrent poster created it first — re-read and append.
      if (!insertError) return { ok: true, posted: true };
      continue;
    }

    const row = existing as TeamThreadRow;
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (rowData.rootMessageId === input.messageId) return { ok: true, posted: false };
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as TeamThreadMessage[])] : [];
    if (messages.some((m) => m?.id === input.messageId)) return { ok: true, posted: false };
    // A shell a queued draft created has no root turn yet: this message is it.
    const rootless = !rowData.rootMessageId && !String(rowData.body ?? "").trim() && messages.length === 0;
    if (!rootless) {
      messages.push({
        id: input.messageId,
        from: actorName,
        body: input.text,
        at: when,
        outbound: true,
        actorUserId: input.actorUserId ?? ownerId,
      });
    }
    const head = rowData.aiDraft as { text?: unknown } | null | undefined;
    const consumed =
      input.consumeDraft && head && typeof head.text === "string" && head.text.trim() === input.text.trim()
        ? advanceDraftSlots(rowData)
        : {};
    const { data: written, error: writeError } = await db
      .from("portal_inbox_thread_records")
      .update({
        row_data: {
          ...rowData,
          ...consumed,
          ...(propertyId ? { propertyId } : {}),
          ...(propertyTitle && !rowData.propertyTitle ? { propertyTitle } : {}),
          ...(rootless
            ? {
                from: actorName,
                body: input.text,
                rootAt: when,
                rootOutbound: true,
                rootActorUserId: input.actorUserId ?? ownerId,
                rootMessageId: input.messageId,
              }
            : {}),
          messages,
          preview,
          time: when,
          unread: true,
        },
        updated_at: updatedAt,
      })
      .eq("id", threadId)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (writeError) return { ok: false, error: "Could not post to the team thread." };
    if (written) return { ok: true, posted: true };
    // Lost the CAS to a concurrent append — loop re-reads and tries again.
  }
  return { ok: false, error: "Could not post to the team thread." };
}

function advanceDraftSlots(rowData: Record<string, unknown>): { aiDraft: unknown; aiDraftQueue: unknown } {
  const queue = Array.isArray(rowData.aiDraftQueue) ? rowData.aiDraftQueue.filter(Boolean) : [];
  const [next, ...rest] = queue;
  return { aiDraft: next, aiDraftQueue: rest.length > 0 ? rest : undefined };
}

const TEAM_THREAD_FOLDERS = new Set(["inbox", "sent", "trash"]);

type DraftSlot = { generatedAt?: unknown } | null | undefined;

function draftId(draft: DraftSlot): string {
  return typeof draft?.generatedAt === "string" ? draft.generatedAt.trim() : "";
}

/**
 * The server's draft slots after the viewer's approvals/discards are applied.
 * Only drafts the browser names in `resolvedAiDraftIds` are removed; a
 * snapshot that simply never saw a draft (it was queued after the page
 * loaded, or by an automation the viewer is not the audience of) changes
 * nothing, so a pending review draft survives an archive from a stale tab.
 */
function mergeTeamDraftSlots(
  row: Record<string, unknown>,
  requested: Record<string, unknown>,
): { aiDraft: unknown; aiDraftQueue: unknown } {
  const resolved = new Set(
    Array.isArray(requested.resolvedAiDraftIds)
      ? requested.resolvedAiDraftIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [],
  );
  const slots = [row.aiDraft as DraftSlot, ...(Array.isArray(row.aiDraftQueue) ? (row.aiDraftQueue as DraftSlot[]) : [])]
    .filter((draft) => draft && !resolved.has(draftId(draft)));
  const [head, ...rest] = slots;
  return { aiDraft: head, aiDraftQueue: rest.length > 0 ? rest : undefined };
}

/**
 * The browser's copy of a team thread is never written back wholesale: the
 * row is shared by the owner and every co-manager on the house, so a stale
 * client snapshot would drop turns others appended (and would stamp the
 * viewer's own email onto `participant_email`). Only the mailbox state a
 * viewer legitimately owns — folder, unread, and the specific drafts they
 * approved or discarded — is merged, under the same CAS the appends use.
 * Messages, root, house tag and every other draft stay exactly as the server
 * holds them.
 */
export async function updateTeamThreadMailboxState(
  db: SupabaseClient,
  target: { id: string },
  requested: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < TEAM_THREAD_APPEND_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("row_data, updated_at")
      .eq("id", target.id)
      .maybeSingle();
    if (error || !data) throw new Error("Could not load the team thread.");
    const row = (data.row_data ?? {}) as Record<string, unknown>;
    const folder = TEAM_THREAD_FOLDERS.has(String(requested.folder)) ? requested.folder : row.folder;
    const next = {
      ...row,
      folder,
      unread: typeof requested.unread === "boolean" ? requested.unread : row.unread,
      ...(folder === "trash" && row.folder !== "trash" ? { previousFolder: row.folder } : {}),
      ...mergeTeamDraftSlots(row, requested),
    };
    const { data: changed, error: writeError } = await db
      .from("portal_inbox_thread_records")
      .update({
        row_data: next,
        updated_at: new Date(Math.max(Date.now(), Date.parse(String(data.updated_at ?? "")) + 1 || 0)).toISOString(),
      })
      .eq("id", target.id)
      .eq("updated_at", data.updated_at)
      .select("id")
      .maybeSingle();
    if (writeError) throw new Error("Could not save the team thread state.");
    if (changed) return;
  }
  throw new Error("Team thread changed; retry the mailbox action.");
}

// ---- WS6: SMS mirror ----

export type TeamSmsMirrorOutcome = {
  memberUserId: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

type MemberPhoneEligibility = { eligible: true; phone: string } | { eligible: false; reason: string };

async function memberPhoneEligibility(
  db: SupabaseClient,
  memberUserId: string,
): Promise<MemberPhoneEligibility> {
  const { data } = await db
    .from("profiles")
    .select("phone, phone_verified_at, sms_forward_inbound")
    .eq("id", memberUserId)
    .maybeSingle();
  const phone = String((data as { phone?: unknown } | null)?.phone ?? "").trim();
  if (!phone) return { eligible: false, reason: "no_phone" };
  if (!(data as { phone_verified_at?: unknown } | null)?.phone_verified_at) return { eligible: false, reason: "phone_unverified" };
  if ((data as { sms_forward_inbound?: unknown } | null)?.sms_forward_inbound === false) {
    return { eligible: false, reason: "member_opted_out_of_texts" };
  }
  if (await isPhoneOptedOut(db, phone)) return { eligible: false, reason: "stop" };
  return { eligible: true, phone };
}

/**
 * Text every OTHER authorized recipient (never the acting manager) the team
 * notice from the owner's registered workspace number. Recipients are the
 * property + module roster (`resolveTeamNoticeRecipientIds`), so a
 * co-manager hears about a payment only on a house they hold Payments on.
 *
 * Quiet hours, consent, and the number's registration/attachment state are
 * all decided by `enqueueOwnerSms` (`owner-sms-dispatcher.server.ts`): a
 * quiet-hours text is stored `deferred` with an `available_at` and sent when
 * the window opens rather than dropped here; the `team_notice` purpose takes
 * its scoped consent from the recipient's own verified work phone (see
 * `sms/team-notice-consent.server.ts`); and the same runtime kill switches
 * every other manager-funded SMS sits behind (`SMS_RUNTIME_ENABLED` /
 * `SMS_OUTBOX_SCHEDULER_READY`) keep it from sending in prod until A2P clears
 * — see `docs/agents/sms-system.md`.
 */
export async function mirrorTeamThreadMessageToSms(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    /** The house this notice is about; absent = owner only. */
    propertyId?: string | null;
    /** The Teams module the notice belongs to — who may hear it. */
    module: TeamNoticeModule;
    actorUserId?: string;
    /** Pass the workspace this notice is ABOUT when known (e.g. a property's workspace); omitted = the owner's default. */
    workspaceId?: string | null;
    subject: string;
    text: string;
    messageId: string;
    urgent?: boolean;
    now?: Date;
  },
): Promise<TeamSmsMirrorOutcome[]> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return [];

  // A workspace number that cannot currently send means nothing to mirror —
  // fail closed once rather than once per member.
  const fromNumber = await resolveActiveManagerSendNumber(db, ownerId, input.workspaceId ?? null).catch(() => null);
  if (!fromNumber) return [];

  const propertyId = input.propertyId?.trim() || null;
  const recipients = (
    await resolveTeamNoticeRecipientIds(db, { ownerManagerUserId: ownerId, propertyId, module: input.module })
  ).filter((id) => id !== input.actorUserId);
  const outcomes: TeamSmsMirrorOutcome[] = [];
  for (const memberUserId of recipients) {
    const eligibility = await memberPhoneEligibility(db, memberUserId);
    if (!eligibility.eligible) {
      outcomes.push({ memberUserId, status: "skipped", reason: eligibility.reason });
      continue;
    }
    const result = await enqueueOwnerSms(
      {
        managerUserId: ownerId,
        actorUserId: input.actorUserId ?? ownerId,
        recipientPhone: eligibility.phone,
        recipientUserId: memberUserId,
        body: `${input.subject}\n${input.text}`.slice(0, 1500),
        sendClass: input.urgent ? "transactional" : "automated",
        purpose: "team_notice",
        counterpartyRole: "manager",
        propertyId,
        dedupeKey: `team-notice:${input.messageId}:${memberUserId}`,
      },
      db,
    ).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "send failed" }));
    outcomes.push(
      result.ok
        ? { memberUserId, status: "sent" }
        : { memberUserId, status: "failed", reason: result.error },
    );
  }
  return outcomes;
}
