import { TEAM_ROOT_TEXT, teamThreadDisplayName } from "@/lib/team-thread-display";
import "server-only";

/**
 * The workspace Team chat: ONE human conversation per workspace, shared by the
 * owner and every accepted teammate, relayed over text from the workspace's
 * work number.
 *
 * Id: `team-thread:<ownerId>:ws:<workspaceId>`, named "Team · <workspace name>".
 * The older ids (`team-thread:<owner>` and `team-thread:<owner>:<propertyId>`)
 * still parse and open so existing rows keep working until
 * `scripts/merge-assistant-team-threads.mjs --team` folds them into the
 * workspace thread.
 *
 * Membership is the workspace's: the owner plus every accepted, non-owner-role
 * teammate whose membership row is for THIS workspace (`account_link_invites`
 * is one row per owner, manager and workspace), regardless of which houses
 * they hold. A Viewer reads and is relayed to but does not post. Automated
 * notices (payments, leases, tours) are never posted here: they go to each
 * person's PropLane Assistant. The thread's name is fixed; the poster's name,
 * `actorUserId` and `channel` ride on each message, and the thread opens with a
 * neutral system line so no person's first message is dressed as "Team".
 *
 * Authorization: `portal_inbox_thread_records` has RLS enabled with ZERO
 * policies for `anon`/`authenticated` (service-role only), so authorization
 * stays in application code: `assertTeamThreadMember` is the gate a route
 * calls before reading or posting, and it re-derives membership from the id.
 *
 * Appends are a compare-and-set on the row's `updated_at` (with a bounded
 * retry, including the insert-conflict path), so two lines landing in the same
 * second can never lose one another's message to a last-writer-wins upsert.
 *
 * The SMS relay (`relayTeamChatMessageToSms`) texts every OTHER member whose
 * phone is verified, not STOPped and still forwarding, FROM the workspace's
 * work number, billed to the workspace OWNER (a teammate is never billed),
 * deduped per (message, member), capped per workspace per hour.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { INVITE_PERMISSION_COLUMNS } from "@/lib/account-link-invite-row";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { TEAM_CHAT_RELAY_SMS_PURPOSE, TEAM_INBOUND_FORWARD_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { teamThreadId, workspaceTeamThreadId } from "@/lib/team-thread-id";

const TEAM_THREAD_APPEND_ATTEMPTS = 4;
/** Relayed texts one workspace may send per hour. Over it, the chat keeps working in-app and the texts wait. */
export const TEAM_CHAT_RELAY_HOURLY_CAP = 60;

/** The Teams module that gates who hears a team notice, by the event's domain. */
export type TeamNoticeModule = import("@/lib/co-manager-permissions").CoManagerPermissionId;

/** How a message travelled: typed in the app (stored as the in-app channel) or texted to the work number. */
export type TeamMessageChannel = "app" | "sms";

export {
  isTeamThreadId,
  parseTeamThreadId,
  teamThreadId,
  workspaceTeamThreadId,
  type ParsedTeamThreadId,
} from "@/lib/team-thread-id";

export type TeamMember = { userId: string; teamRole: string | null; isOwner: boolean };

/**
 * Everyone in a workspace's Team chat: the owner first, then each accepted
 * teammate whose membership row is for this workspace (a row with no workspace
 * is the owner's default workspace's), never a property-owner row. Any read
 * failure narrows to the owner alone: a widened roster is a widened surface.
 */
export async function resolveWorkspaceTeamMembers(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; workspaceId?: string | null },
): Promise<TeamMember[]> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return [];
  const members: TeamMember[] = [{ userId: ownerId, teamRole: null, isOwner: true }];
  const requested = input.workspaceId?.trim() ?? "";
  try {
    const defaultId = await userDefaultWorkspaceId(db, ownerId);
    // No workspace asked for = the owner's DEFAULT workspace, the same place
    // `postTeamThreadMessage` sends such a line. Reading it as "no filter"
    // returned every workspace's teammates, so an unplaced work number admitted
    // (and relayed to) people who are not in the chat the line lands in.
    const workspaceId = requested || defaultId;
    const { data, error } = withoutOwnerLinks(
      await db
        .from("account_link_invites")
        .select(`invitee_user_id, workspace_id, ${INVITE_PERMISSION_COLUMNS}`)
        .eq("status", "accepted")
        .eq("inviter_user_id", ownerId),
    );
    if (error) return members;
    const seen = new Set<string>([ownerId]);
    for (const row of (data ?? []) as Array<{ invitee_user_id?: unknown; workspace_id?: unknown; team_role?: unknown }>) {
      const inviteeId = String(row.invitee_user_id ?? "").trim();
      if (!inviteeId || seen.has(inviteeId)) continue;
      const rowWorkspace = String(row.workspace_id ?? "").trim() || defaultId;
      if (workspaceId && rowWorkspace !== workspaceId) continue;
      seen.add(inviteeId);
      members.push({ userId: inviteeId, teamRole: String(row.team_role ?? "").trim() || null, isOwner: false });
    }
  } catch {
    return [{ userId: ownerId, teamRole: null, isOwner: true }];
  }
  return members;
}

/** The member ids of a workspace's Team chat (owner first). */
export async function resolveTeamNoticeRecipientIds(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; workspaceId?: string | null },
): Promise<string[]> {
  return (await resolveWorkspaceTeamMembers(db, input)).map((member) => member.userId);
}

/** A Viewer reads the chat and is texted its lines, but does not post. */
export function teamMemberCanPost(member: TeamMember | undefined): boolean {
  return Boolean(member) && member!.teamRole !== "viewer";
}

/**
 * May `userId` read (`level: "read"`) or post (`level: "edit"`) this team chat?
 * The owner always. For a workspace chat, a member of THAT workspace (a Viewer
 * reads only). For a legacy per-house id, a co-manager whose accepted link
 * assigns that house with Communication at that level (the rule the legacy
 * rows were listed by); a house-less legacy thread is the owner's alone.
 */
export async function assertTeamThreadMember(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    workspaceId?: string | null;
    propertyId?: string | null;
    userId: string;
    level?: "read" | "edit";
  },
): Promise<boolean> {
  const ownerId = input.ownerManagerUserId.trim();
  const userId = input.userId.trim();
  if (!ownerId || !userId) return false;
  if (userId === ownerId) return true;
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (workspaceId) {
    const member = (await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: ownerId, workspaceId })).find(
      (candidate) => candidate.userId === userId,
    );
    if (!member) return false;
    return input.level === "edit" ? teamMemberCanPost(member) : true;
  }
  const propertyId = input.propertyId?.trim() ?? "";
  if (!propertyId) return false;
  try {
    const { asStringArray, readPropertyPermissionsFromRow } = await import("@/lib/account-link-invite-row");
    const { hasCoManagerPermissionLevelForProperty } = await import("@/lib/co-manager-permissions");
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
  channel?: "sms" | "proplane";
};

type TeamThreadRow = { id: string; row_data: Record<string, unknown> | null; updated_at: string | null };

async function workspaceDisplayName(db: SupabaseClient, workspaceId: string): Promise<string> {
  try {
    const { data } = await db.from("portal_workspaces").select("name").eq("id", workspaceId).maybeSingle();
    return String((data as { name?: unknown } | null)?.name ?? "").trim();
  } catch {
    return "";
  }
}

/** The workspace a post is for: the one named, else the owner's default; empty only for a legacy id. */
async function postWorkspaceId(db: SupabaseClient, ownerId: string, workspaceId: string | null | undefined): Promise<string> {
  return workspaceId?.trim() || (await userDefaultWorkspaceId(db, ownerId));
}

/**
 * Make sure a workspace with two or more people has its Team chat row, so
 * anyone in it can start the conversation (nothing automated ever creates it
 * any more). One cheap existence read on the hot path; the roster is read only
 * when the chat is missing. Insert-only: a concurrent creator wins, never an
 * overwrite. A solo workspace gets no chat (everything it texts goes to the
 * Assistant). Returns the thread id, or null when none is warranted.
 */
export async function ensureWorkspaceTeamThread(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; workspaceId: string },
): Promise<string | null> {
  const ownerId = input.ownerManagerUserId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!ownerId || !workspaceId) return null;
  const threadId = workspaceTeamThreadId(ownerId, workspaceId);
  const { data: existing } = await db.from("portal_inbox_thread_records").select("id").eq("id", threadId).maybeSingle();
  if (existing) return threadId;
  const members = await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: ownerId, workspaceId });
  if (members.length < 2) return null;
  const name = teamThreadDisplayName(await workspaceDisplayName(db, workspaceId));
  const when = formatPacificDateTime(new Date());
  const { error } = await db.from("portal_inbox_thread_records").insert({
    id: threadId,
    scope: MANAGER_INBOX_STORAGE_KEY,
    owner_user_id: ownerId,
    participant_email: null,
    thread_type: "team",
    row_data: {
      id: threadId,
      folder: "inbox",
      from: name,
      email: "",
      subject: name,
      preview: "",
      body: TEAM_ROOT_TEXT,
      time: when,
      rootAt: when,
      rootOutbound: true,
      unread: false,
      scope: MANAGER_INBOX_STORAGE_KEY,
      rootMessageId: `team-root:${threadId}`,
      workspaceId,
      messages: [],
    },
    updated_at: new Date().toISOString(),
  });
  // A duplicate key means another request created it first: that is success.
  return error && !String((error as { code?: unknown }).code ?? "").includes("23505") && !/duplicate/i.test(String(error.message ?? ""))
    ? null
    : threadId;
}

/**
 * Post one line into a workspace's Team chat (or, for a legacy id the caller
 * parsed, that legacy thread), attributed to the poster. Idempotent on
 * `messageId` (a retried delivery or a replayed webhook must not double-post)
 * and atomic per append (CAS on `updated_at`, retried; an insert that loses to
 * a concurrent creator falls through to the same CAS append).
 */
export async function postTeamThreadMessage(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    /** The workspace chat. Omitted with no `propertyId` = the owner's default workspace. */
    workspaceId?: string | null;
    /** A LEGACY per-house thread being replied to in place. */
    propertyId?: string | null;
    /**
     * A LEGACY house-less thread (`team-thread:<owner>`) being replied to in
     * place. Without it the line resolves to the owner's default workspace chat
     * and lands in a thread the reader is not looking at.
     */
    legacyHouseless?: boolean;
    actorUserId?: string;
    actorName: string;
    text: string;
    messageId: string;
    channel?: TeamMessageChannel;
  },
): Promise<{ ok: true; posted: boolean; threadId: string; workspaceId: string | null } | { ok: false; error: string }> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return { ok: false, error: "Team thread requires an owning manager." };
  const legacyPropertyId = input.propertyId?.trim() || null;
  const legacyInPlace = legacyPropertyId !== null || input.legacyHouseless === true;
  const workspaceId = legacyInPlace ? "" : await postWorkspaceId(db, ownerId, input.workspaceId);
  const threadId = workspaceId ? workspaceTeamThreadId(ownerId, workspaceId) : teamThreadId(ownerId, legacyPropertyId);
  const workspaceName = workspaceId ? await workspaceDisplayName(db, workspaceId) : "";
  const threadName = workspaceId ? teamThreadDisplayName(workspaceName) : teamThreadDisplayName();
  const actorName = input.actorName.trim() || "PropLane";
  const preview = input.text.slice(0, 100).replace(/\n/g, " ");
  const channel: "sms" | "proplane" = input.channel === "sms" ? "sms" : "proplane";
  const base = {
    id: threadId,
    scope: MANAGER_INBOX_STORAGE_KEY,
    owner_user_id: ownerId,
    participant_email: null,
    thread_type: "team",
  };
  const message = (when: string): TeamThreadMessage => ({
    id: input.messageId,
    from: actorName,
    body: input.text,
    at: when,
    outbound: true,
    actorUserId: input.actorUserId ?? ownerId,
    channel,
  });

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
          // The thread is the team's, not a person's: its name is fixed and the
          // first turn is a neutral line, so every real line carries its poster.
          from: threadName,
          email: "",
          subject: threadName,
          preview,
          body: TEAM_ROOT_TEXT,
          time: when,
          rootAt: when,
          rootOutbound: true,
          unread: true,
          scope: MANAGER_INBOX_STORAGE_KEY,
          rootMessageId: `team-root:${threadId}`,
          ...(workspaceId ? { workspaceId } : {}),
          messages: [message(when)],
        },
        updated_at: updatedAt,
      });
      // No conflict: this call created the thread with the line in it.
      // A conflict means a concurrent poster created it first - re-read and append.
      if (!insertError) return { ok: true, posted: true, threadId, workspaceId: workspaceId || null };
      continue;
    }

    const row = existing as TeamThreadRow;
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (rowData.rootMessageId === input.messageId) return { ok: true, posted: false, threadId, workspaceId: workspaceId || null };
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as TeamThreadMessage[])] : [];
    if (messages.some((m) => m?.id === input.messageId)) return { ok: true, posted: false, threadId, workspaceId: workspaceId || null };
    messages.push(message(when));
    const { data: written, error: writeError } = await db
      .from("portal_inbox_thread_records")
      .update({
        row_data: {
          ...rowData,
          // Heal a row an older writer named after its first poster.
          from: threadName,
          ...(workspaceId ? { workspaceId } : {}),
          messages,
          preview,
          time: when,
          unread: true,
          // A new line pulls the chat back out of trash for everyone.
          folder: rowData.folder === "trash" ? "inbox" : rowData.folder ?? "inbox",
        },
        updated_at: updatedAt,
      })
      .eq("id", threadId)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (writeError) return { ok: false, error: "Could not post to the team thread." };
    if (written) return { ok: true, posted: true, threadId, workspaceId: workspaceId || null };
    // Lost the CAS to a concurrent append - loop re-reads and tries again.
  }
  return { ok: false, error: "Could not post to the team thread." };
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

// ---- SMS relay ----

export type TeamSmsRelayOutcome = {
  memberUserId: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

type MemberPhoneEligibility = { eligible: true; phone: string } | { eligible: false; reason: string };

export async function memberPhoneEligibility(
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

/** "Prakrit Ramachandran" -> "Prakrit"; an unnamed member reads "A teammate". */
export function teamRelayFirstName(fullName: string | null | undefined): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return first || "A teammate";
}

/**
 * Texts a workspace may still relay this hour. Chat relays and forwarded
 * resident / prospect texts to teammates share ONE cap per workspace line,
 * counted from `sms_outbox`. An unreadable count is "none left" (fail closed).
 */
export async function teamRelayCapRemaining(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; numberId: string | null; now?: Date; cap?: number },
): Promise<number> {
  const cap = input.cap ?? TEAM_CHAT_RELAY_HOURLY_CAP;
  const since = new Date((input.now ?? new Date()).getTime() - 60 * 60_000).toISOString();
  let used = cap;
  try {
    let query = db
      .from("sms_outbox")
      .select("id", { count: "exact", head: true })
      .eq("manager_user_id", input.ownerManagerUserId)
      .in("purpose", [TEAM_CHAT_RELAY_SMS_PURPOSE, TEAM_INBOUND_FORWARD_SMS_PURPOSE])
      .gte("created_at", since);
    if (input.numberId) query = query.eq("selected_work_line_id", input.numberId);
    const { count, error } = await query;
    used = error ? cap : (count ?? 0);
  } catch {
    used = cap;
  }
  return Math.max(0, cap - used);
}

/**
 * Text one Team chat line to every OTHER member (never the sender) from the
 * workspace's work number, billed to the workspace OWNER. A member is texted
 * only with a verified phone that has not replied STOP and still forwards;
 * the dispatcher re-checks that consent, the number's registration and the
 * owner's credit (reserved before the provider call). Body: "<FirstName>: <text>".
 * Deduped per (message, member); at most {@link TEAM_CHAT_RELAY_HOURLY_CAP}
 * relayed texts per workspace per hour (the chat itself is unaffected).
 * No work number or no credit = no texts, never an error for the chat.
 */
export async function relayTeamChatMessageToSms(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    workspaceId?: string | null;
    senderUserId: string;
    senderName: string;
    text: string;
    messageId: string;
    now?: Date;
    cap?: number;
  },
): Promise<TeamSmsRelayOutcome[]> {
  const ownerId = input.ownerManagerUserId.trim();
  const senderId = input.senderUserId.trim();
  if (!ownerId || !senderId) return [];
  const workspaceId = (await postWorkspaceId(db, ownerId, input.workspaceId)) || null;

  // A workspace line that cannot currently send means nothing to relay -
  // fail closed once rather than once per member.
  const line = await resolveWorkspaceSendLine(db, ownerId, workspaceId).catch(() => null);
  if (!line) return [];

  const members = await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: ownerId, workspaceId });
  const recipients = members.filter((member) => member.userId !== senderId);
  if (recipients.length === 0) return [];

  // Per-workspace hourly cap, counted from the outbox itself (durable, shared
  // across instances). Over it the texts are skipped; the chat keeps working.
  let remaining = await teamRelayCapRemaining(db, {
    ownerManagerUserId: ownerId,
    numberId: line.numberId,
    now: input.now,
    cap: input.cap,
  });

  const body = `${teamRelayFirstName(input.senderName)}: ${input.text.trim()}`.slice(0, 1500);
  const outcomes: TeamSmsRelayOutcome[] = [];
  for (const member of recipients) {
    const eligibility = await memberPhoneEligibility(db, member.userId);
    if (!eligibility.eligible) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: eligibility.reason });
      continue;
    }
    if (remaining <= 0) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: "hourly_cap" });
      continue;
    }
    remaining -= 1;
    const result = await enqueueOwnerSms(
      {
        managerUserId: ownerId,
        actorUserId: senderId,
        selectedWorkLineId: line.numberId,
        recipientPhone: eligibility.phone,
        recipientUserId: member.userId,
        body,
        // Person-to-person chat: a transactional text, not quiet-hours-held automation.
        sendClass: "transactional",
        purpose: TEAM_CHAT_RELAY_SMS_PURPOSE,
        counterpartyRole: "manager",
        suppressConversationLog: true,
        dedupeKey: `team-chat:${input.messageId}:${member.userId}`,
      },
      db,
    ).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "send failed" }));
    outcomes.push(
      result.ok
        ? { memberUserId: member.userId, status: "sent" }
        : { memberUserId: member.userId, status: "failed", reason: result.error },
    );
  }
  return outcomes;
}
