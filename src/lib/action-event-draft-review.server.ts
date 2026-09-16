import "server-only";

/**
 * Draft-for-review (WS5, opt-in — see `src/lib/automation-send-mode.ts` for
 * why the shipped default stays "auto"). When a workspace turns on
 * `automationSendMode.partyFacing === "draft"`, a resident/vendor
 * `ActionEventRecipient` marked `draftForReview: true` (see
 * `action-events.server.ts`) lands here instead of being sent: a pending
 * draft on the MANAGER's own copy of that recipient's thread, reusing the
 * existing `InboxAiDraft` shape (`portal-inbox-storage.ts`) so the manager's
 * inbox renders it with the same Approve & Send affordance an AI-drafted
 * reply gets. Nothing is delivered to the resident/vendor until the manager
 * approves.
 *
 * Integration note: the existing Approve & Send flow
 * (`pro-inbox.tsx`'s `aiDraft` handling) was built for drafting a REPLY to an
 * inbound message on an already-open thread. This function attaches the same
 * `aiDraft` shape to a thread that may have no prior messages at all (a
 * proactive notice, not a reply) — the storage/gating half of that is
 * implemented and tested here; end-to-end behavior of the Approve & Send
 * button against a draft with no preceding inbound turn has not been
 * separately verified in the browser and is worth a follow-up pass before
 * `automationSendMode.partyFacing` is defaulted to `"draft"` for real
 * traffic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";

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
  const aiDraft = {
    text: input.text,
    status: "pending_approval" as const,
    generatedAt,
    model: input.origin,
  };

  const { data: existingRows, error: findError } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, updated_at")
    .eq("scope", MANAGER_INBOX_STORAGE_KEY)
    .eq("owner_user_id", managerUserId)
    .eq("participant_email", participantEmail)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (findError) return { ok: false, error: "Could not resolve the recipient's conversation." };

  const existing = existingRows?.[0] as { id: string; row_data: Record<string, unknown> } | undefined;
  if (existing) {
    const rowData = (existing.row_data ?? {}) as Record<string, unknown>;
    // A newer draft or an already-approved/discarded slot always wins over a
    // stale one; never clobber a manager's own in-progress reply draft state
    // beyond replacing the automated suggestion.
    const { error } = await db
      .from("portal_inbox_thread_records")
      .update({ row_data: { ...rowData, aiDraft }, updated_at: generatedAt })
      .eq("id", existing.id);
    if (error) return { ok: false, error: "Could not queue the draft for review." };
    return { ok: true };
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
  });
  if (insertError) return { ok: false, error: "Could not queue the draft for review." };
  return { ok: true };
}
