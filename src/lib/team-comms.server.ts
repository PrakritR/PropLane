import "server-only";

/**
 * Manager <-> manager "Team" thread (WS5) + its SMS mirror (WS6), PLAN-0915
 * phase 5.
 *
 * There is no manager<->manager messaging today (see
 * `docs/agents/communication-inbox.md`: "There is NO manager<->manager
 * thread today"). This module adds exactly one new kind of
 * `portal_inbox_thread_records` row per owning-manager account —
 * `thread_type: "team"` — that every team-audience action event posts into,
 * attributed "as <acting manager>". It reuses the existing table (additive:
 * `thread_type` is an unconstrained free-text column, see
 * `supabase/migrations/20260428201000_portal_backend_records.sql`) rather
 * than inventing a parallel store, matching "Inbox is the record" (AGENTS.md
 * -> Multi-agent collaboration / communication-inbox.md).
 *
 * Scope decision: a team thread is per OWNING MANAGER ACCOUNT, not per
 * `portal_workspaces` row. `manager_automation_settings`, the automated
 * message catalogue, and every existing action-event emitter already key on
 * `managerUserId` (the account), not workspace id — action events carry no
 * workspace context today. Threading a `workspace_id` through every emitter
 * in this slice (application/lease/payment/tour/work-order) to support
 * multiple independent team threads per owner is out of scope; a Business
 * owner's several workspaces share one Team thread, the same way they share
 * one `manager_automation_settings` row. WS6's SMS mirror still resolves the
 * correct PER-WORKSPACE sending number (see `mirrorTeamThreadMessageToSms`
 * below) via `enqueueOwnerSms`'s own workspace resolution.
 *
 * Membership: the owner plus every co-manager with an ACCEPTED
 * `account_link_invites` row for that owner (`resolveTeamMemberIds`). This is
 * intentionally broader than any single module's notification permission
 * (`loadCoManagerNotificationRecipients`) — a Team thread is the whole team's
 * shared channel, not a permission-gated alert.
 *
 * Authorization: `portal_inbox_thread_records` has RLS enabled with ZERO
 * policies for `anon`/`authenticated` (service-role only; see
 * `docs/agents/communication-inbox.md` "authorize then append" and the table's
 * own migration) — the same pattern as every other row in this table. Adding
 * client-reachable RLS policies here would be a NEW access model this table
 * has never had, so authorization stays in application code, exactly like
 * `resolveInboxThreadReplyTarget`/`commitInboxThreadReply` do for person
 * threads: `assertTeamThreadMember` below is the one gate every read/write
 * route into a team thread must call.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/** One Team thread per owning manager account. Deterministic, so posting is idempotent-by-construction. */
export function teamThreadId(ownerManagerUserId: string): string {
  return `team-thread:${ownerManagerUserId.trim()}`;
}

export function isTeamThreadId(id: string): boolean {
  return id.startsWith("team-thread:");
}

/** Owner + every co-manager with an accepted link to that owner. Order: owner first. */
export async function resolveTeamMemberIds(db: SupabaseClient, ownerManagerUserId: string): Promise<string[]> {
  const ownerId = ownerManagerUserId.trim();
  if (!ownerId) return [];
  const members = new Set<string>([ownerId]);
  try {
    const { data, error } = await db
      .from("account_link_invites")
      .select("invitee_user_id")
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId);
    if (!error) {
      for (const row of data ?? []) {
        const id = String((row as { invitee_user_id?: unknown }).invitee_user_id ?? "").trim();
        if (id) members.add(id);
      }
    }
  } catch {
    /* table may not exist in a minimal test harness — owner-only membership is still correct */
  }
  return [...members];
}

/** True when `userId` may read/post this owner's Team thread. */
export async function assertTeamThreadMember(
  db: SupabaseClient,
  ownerManagerUserId: string,
  userId: string,
): Promise<boolean> {
  const members = await resolveTeamMemberIds(db, ownerManagerUserId);
  return members.includes(userId.trim());
}

type TeamThreadMessage = {
  id: string;
  from: string;
  body: string;
  at: string;
  outbound?: boolean;
};

/**
 * Post one message into the owner's Team thread, attributed to the acting
 * manager. Idempotent on `messageId` (matches the action-event bus's
 * idempotent-per-eventKey contract — a retried delivery must not double-post).
 */
export async function postTeamThreadMessage(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    actorUserId?: string;
    actorName: string;
    subject: string;
    text: string;
    smsText?: string;
    messageId: string;
    urgent?: boolean;
  },
): Promise<{ ok: true; posted: boolean } | { ok: false; error: string }> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return { ok: false, error: "Team thread requires an owning manager." };
  const threadId = teamThreadId(ownerId);
  const when = formatPacificDateTime(new Date());
  const actorName = input.actorName.trim() || "PropLane";
  const preview = input.text.slice(0, 100).replace(/\n/g, " ");

  const { data: existing, error: readError } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data")
    .eq("id", threadId)
    .maybeSingle();
  if (readError) return { ok: false, error: "Could not load the team thread." };

  if (!existing) {
    const { error: insertError } = await db.from("portal_inbox_thread_records").insert({
      id: threadId,
      scope: MANAGER_INBOX_STORAGE_KEY,
      owner_user_id: ownerId,
      participant_email: null,
      thread_type: "team",
      row_data: {
        id: threadId,
        folder: "inbox",
        from: actorName,
        email: "",
        subject: "Team",
        preview,
        body: input.text,
        time: when,
        rootAt: when,
        rootOutbound: true,
        unread: true,
        scope: MANAGER_INBOX_STORAGE_KEY,
        rootMessageId: input.messageId,
        messages: [] as TeamThreadMessage[],
      },
    });
    // No conflict: this call created the thread with this message as its root.
    if (!insertError) return { ok: true, posted: true };
    // Conflict (a concurrent poster created it first) falls through to append below.
  } else {
    const rowData = (existing.row_data ?? {}) as Record<string, unknown>;
    if (rowData.rootMessageId === input.messageId) return { ok: true, posted: false };
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as TeamThreadMessage[])] : [];
    if (messages.some((m) => m?.id === input.messageId)) return { ok: true, posted: false };
    messages.push({ id: input.messageId, from: actorName, body: input.text, at: when, outbound: true });
    const { error: writeError } = await db.from("portal_inbox_thread_records").upsert(
      {
        id: threadId,
        scope: MANAGER_INBOX_STORAGE_KEY,
        owner_user_id: ownerId,
        participant_email: null,
        thread_type: "team",
        row_data: { ...rowData, messages, preview, time: when, unread: true },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (writeError) return { ok: false, error: "Could not post to the team thread." };
    return { ok: true, posted: true };
  }

  // Re-read after the insert conflict and append.
  const { data: freshRow, error: rereadError } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data")
    .eq("id", threadId)
    .maybeSingle();
  if (rereadError || !freshRow) return { ok: false, error: "Could not load the team thread." };
  const rowData = (freshRow.row_data ?? {}) as Record<string, unknown>;
  if (rowData.rootMessageId === input.messageId) return { ok: true, posted: false };
  const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as TeamThreadMessage[])] : [];
  if (messages.some((m) => m?.id === input.messageId)) return { ok: true, posted: false };
  messages.push({ id: input.messageId, from: actorName, body: input.text, at: when, outbound: true });
  const { error: writeError } = await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: MANAGER_INBOX_STORAGE_KEY,
      owner_user_id: ownerId,
      participant_email: null,
      thread_type: "team",
      row_data: { ...rowData, messages, preview, time: when, unread: true },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (writeError) return { ok: false, error: "Could not post to the team thread." };
  return { ok: true, posted: true };
}

// ---- WS6: SMS mirror ----

export type TeamSmsMirrorOutcome = {
  memberUserId: string;
  status: "sent" | "skipped" | "deferred" | "failed";
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
 * Text every OTHER team member (never the acting manager) the team notice
 * from the owner's registered workspace number, honouring quiet hours (a
 * non-urgent notice is skipped rather than queued — see the module doc for
 * the scope this leaves for a follow-up durable-retry slice), consent, and
 * the number's own registration/attachment state. Behind the same runtime
 * kill switches every other manager-funded SMS already sits behind
 * (`enqueueOwnerSms` -> `owner-sms-dispatcher.server.ts` fails closed when
 * `SMS_RUNTIME_ENABLED`/`SMS_OUTBOX_SCHEDULER_READY` are off, so nothing
 * sends in prod until A2P clears — see `docs/agents/sms-system.md`).
 */
export async function mirrorTeamThreadMessageToSms(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
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
  const now = input.now ?? new Date();

  // A workspace number that cannot currently send means nothing to mirror —
  // fail closed once rather than once per member.
  const fromNumber = await resolveActiveManagerSendNumber(db, ownerId, input.workspaceId ?? null).catch(() => null);
  if (!fromNumber) return [];

  if (!input.urgent && isWithinQuietHours(now)) {
    const members = await resolveTeamMemberIds(db, ownerId);
    return members
      .filter((id) => id !== input.actorUserId)
      .map((memberUserId) => ({ memberUserId, status: "deferred" as const, reason: "quiet_hours" }));
  }

  const members = (await resolveTeamMemberIds(db, ownerId)).filter((id) => id !== input.actorUserId);
  const outcomes: TeamSmsMirrorOutcome[] = [];
  for (const memberUserId of members) {
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
