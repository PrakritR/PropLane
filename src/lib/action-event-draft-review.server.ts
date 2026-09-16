import "server-only";

/**
 * Draft-for-review (WS5, opt-in — see `src/lib/automation-send-mode.ts` for
 * why the shipped default stays "auto"). When a workspace turns on
 * `automationSendMode.partyFacing === "draft"`, a resident/vendor
 * `ActionEventRecipient` (see `action-events.server.ts`) lands here instead
 * of being sent: a pending draft on the MANAGER's own copy of that
 * recipient's thread, reusing the existing `InboxAiDraft` shape
 * (`portal-inbox-storage.ts`) so the manager's inbox renders it with the
 * same Approve & Send affordance an AI-drafted reply gets. Nothing is
 * delivered to the resident/vendor until the manager approves.
 *
 * Two things distinguish a queued automation draft from an AI reply draft:
 *
 * - `requiresReview: true`. The inbox's AI auto-send latch (`pro-inbox.tsx`)
 *   skips it — a draft the manager asked to review first must never be sent
 *   by the toggle that auto-sends AI replies.
 * - It never overwrites a draft still `pending_approval`. A second automated
 *   event for the same person while the first is still waiting queues behind
 *   it (`aiDraftQueue`, promoted by `advanceInboxAiDraft` once the head is
 *   approved or discarded), so no draft is lost silently.
 *
 * `automationSendMode.team === "draft"` routes a TEAM notice the same way,
 * onto the team thread itself (`queueTeamThreadDraftForReview`); approving it
 * posts through the team-thread reply path.
 *
 * Integration note: the existing Approve & Send flow was built for drafting
 * a REPLY to an inbound message on an already-open thread. These functions
 * attach the same `aiDraft` shape to a thread that may have no prior messages
 * at all (a proactive notice, not a reply) — the storage/gating half is
 * implemented and tested here; end-to-end behavior of the Approve & Send
 * button against a draft with no preceding inbound turn is worth a browser
 * pass before `partyFacing` is defaulted to `"draft"` for real traffic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_INBOX_STORAGE_KEY, type InboxAiDraft } from "@/lib/portal-inbox-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { teamThreadId } from "@/lib/team-comms.server";

const DRAFT_ATTACH_ATTEMPTS = 4;

function reviewDraft(input: { text: string; origin: string; generatedAt: string }): InboxAiDraft {
  return {
    text: input.text,
    status: "pending_approval",
    generatedAt: input.generatedAt,
    model: input.origin,
    origin: input.origin,
    requiresReview: true,
  };
}

function draftAlreadyQueued(rowData: Record<string, unknown>, draft: InboxAiDraft): boolean {
  const same = (candidate: unknown) => {
    const c = candidate as Partial<InboxAiDraft> | null;
    return Boolean(c && c.status === "pending_approval" && c.text === draft.text && c.origin === draft.origin);
  };
  if (same(rowData.aiDraft)) return true;
  return Array.isArray(rowData.aiDraftQueue) && rowData.aiDraftQueue.some(same);
}

/**
 * Attach `draft` to an existing thread row without displacing a pending one:
 * the head slot is taken only when it is free; otherwise the draft queues.
 * CAS on `updated_at` so two automation drafts arriving together both land.
 */
async function attachDraftToThread(
  db: SupabaseClient,
  threadId: string,
  draft: InboxAiDraft,
): Promise<{ ok: true; attached: boolean } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < DRAFT_ATTACH_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, row_data, updated_at")
      .eq("id", threadId)
      .maybeSingle();
    if (error) return { ok: false, error: "Could not resolve the recipient's conversation." };
    if (!data) return { ok: true, attached: false };
    const row = data as { id: string; row_data: Record<string, unknown> | null; updated_at: string | null };
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (draftAlreadyQueued(rowData, draft)) return { ok: true, attached: true };
    const head = rowData.aiDraft as Partial<InboxAiDraft> | null | undefined;
    const headPending = Boolean(head && head.status === "pending_approval" && typeof head.text === "string" && head.text.trim());
    const queue = Array.isArray(rowData.aiDraftQueue) ? (rowData.aiDraftQueue as InboxAiDraft[]) : [];
    const nextRowData = headPending
      ? { ...rowData, aiDraftQueue: [...queue, draft] }
      : { ...rowData, aiDraft: draft };
    const { data: written, error: writeError } = await db
      .from("portal_inbox_thread_records")
      .update({ row_data: nextRowData, updated_at: draft.generatedAt })
      .eq("id", threadId)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (writeError) return { ok: false, error: "Could not queue the draft for review." };
    if (written) return { ok: true, attached: true };
  }
  return { ok: false, error: "Could not queue the draft for review." };
}

export async function queueActionEventDraftForReview(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    recipientEmail?: string;
    recipientUserId?: string;
    subject: string;
    text: string;
    /** `automation:<domain>:<event>` — audit trail for where the draft came from. */
    origin: string;
    draftId: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const managerUserId = input.managerUserId.trim();
  const participantEmail = input.recipientEmail?.trim().toLowerCase();
  if (!managerUserId || !participantEmail) {
    return { ok: false, error: "Draft-for-review requires a manager and a recipient email." };
  }
  const now = new Date();
  const generatedAt = now.toISOString();
  const aiDraft = reviewDraft({ text: input.text, origin: input.origin, generatedAt });

  const { data: existingRows, error: findError } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, updated_at")
    .eq("scope", MANAGER_INBOX_STORAGE_KEY)
    .eq("owner_user_id", managerUserId)
    .eq("participant_email", participantEmail)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (findError) return { ok: false, error: "Could not resolve the recipient's conversation." };

  const existing = existingRows?.[0] as { id: string } | undefined;
  if (existing) {
    const attached = await attachDraftToThread(db, existing.id, aiDraft);
    if (!attached.ok) return attached;
    if (attached.attached) return { ok: true };
  }

  // No existing manager<->recipient thread: create a minimal shell so the
  // draft has somewhere to render. The shell carries no visible message body
  // of its own — only the pending draft — until the manager approves it.
  const threadId = `action-draft:${managerUserId}:${input.draftId}`;
  const when = formatPacificDateTime(now);
  const { error: insertError } = await db.from("portal_inbox_thread_records").insert({
    id: threadId,
    scope: MANAGER_INBOX_STORAGE_KEY,
    owner_user_id: managerUserId,
    participant_email: participantEmail,
    thread_type: "portal_message",
    row_data: {
      id: threadId,
      folder: "inbox",
      from: participantEmail,
      email: participantEmail,
      subject: input.subject,
      preview: "",
      body: "",
      time: when,
      rootAt: when,
      unread: false,
      scope: MANAGER_INBOX_STORAGE_KEY,
      messages: [],
      aiDraft,
    },
    updated_at: generatedAt,
  });
  if (!insertError) return { ok: true };
  // The shell already exists (a retry of this same draft): attach onto it.
  const attached = await attachDraftToThread(db, threadId, aiDraft);
  if (!attached.ok) return attached;
  return attached.attached ? { ok: true } : { ok: false, error: "Could not queue the draft for review." };
}

/**
 * A team notice under `automationSendMode.team === "draft"`: queued on the
 * owner's team thread for the house (or the house-less one) instead of
 * posted. Approving it goes through the team-thread reply path, which posts
 * and mirrors to SMS exactly as an auto-sent notice would have.
 */
export async function queueTeamThreadDraftForReview(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
    subject: string;
    text: string;
    origin: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return { ok: false, error: "Team draft requires an owning manager." };
  const propertyId = input.propertyId?.trim() || null;
  const threadId = teamThreadId(ownerId, propertyId);
  const now = new Date();
  const generatedAt = now.toISOString();
  const aiDraft = reviewDraft({ text: input.text, origin: input.origin, generatedAt });

  const attached = await attachDraftToThread(db, threadId, aiDraft);
  if (!attached.ok) return attached;
  if (attached.attached) return { ok: true };

  const when = formatPacificDateTime(now);
  const { error: insertError } = await db.from("portal_inbox_thread_records").insert({
    id: threadId,
    scope: MANAGER_INBOX_STORAGE_KEY,
    owner_user_id: ownerId,
    participant_email: null,
    thread_type: "team",
    row_data: {
      id: threadId,
      folder: "inbox",
      from: "Team",
      email: "",
      subject: "Team",
      preview: "",
      body: "",
      time: when,
      rootAt: when,
      rootOutbound: true,
      unread: false,
      scope: MANAGER_INBOX_STORAGE_KEY,
      ...(propertyId ? { propertyId } : {}),
      messages: [],
      aiDraft,
    },
    updated_at: generatedAt,
  });
  if (!insertError) return { ok: true };
  const retried = await attachDraftToThread(db, threadId, aiDraft);
  if (!retried.ok) return retried;
  return retried.attached ? { ok: true } : { ok: false, error: "Could not queue the team draft for review." };
}
