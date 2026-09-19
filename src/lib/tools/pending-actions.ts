/**
 * Server-side persistence for proposed write actions — the preview→confirm
 * gate's storage layer. The confirm request carries ONLY a row id; the stored
 * input (validated at propose time and re-validated at confirm time) is what
 * executes — model/client-supplied arguments are never trusted at confirm
 * time. The atomic status flip (proposed -> executed/denied) is the replay
 * guard, and the stored preview is an audit of exactly what the user was shown.
 *
 * Proposals are deliberately NOT superseded by newer ones: the manager
 * dashboard lists every open proposal as an approvable "AI draft" chip, and the
 * approval-first tour flow parks long-lived (7-day) proposals in the same
 * table. `expiresInMs` is what distinguishes a live chat turn from that queue.
 */
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { currentSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { sameSmsTestProvenance, type SmsTestProvenance } from "@/lib/sms/sms-test-provenance";
import type { ActionPreview } from "./registry";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Live chat proposals expire after 15 minutes unless a caller overrides. */
export const CHAT_PENDING_ACTION_TTL_MS = 15 * 60_000;

type DatabaseError = { code?: string | null; message?: string | null; details?: string | null };

function isMissingColumn(error: unknown, column: string): boolean {
  const candidate = error as DatabaseError | null;
  const detail = `${candidate?.message ?? ""} ${candidate?.details ?? ""}`.toLowerCase();
  return detail.includes(column.toLowerCase()) && (detail.includes("column") || candidate?.code === "PGRST204");
}

function isForeignKeyViolation(error: unknown): boolean {
  return (error as DatabaseError | null)?.code === "23503";
}

function pendingActionInsertPayload(
  args: {
    landlordId: string;
    userId: string;
    toolName: string;
    input: unknown;
    preview: ActionPreview;
    portal?: AgentPortal;
    sessionId?: string | null;
    expiresInMs?: number;
    proposalTraceId?: string | null;
    smsTestProvenance?: SmsTestProvenance | null;
  },
  opts: { includeSessionId: boolean; includeProposalTraceId: boolean; includePortal: boolean },
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    landlord_id: args.landlordId || args.userId,
    user_id: args.userId,
    tool_name: args.toolName,
    input: args.input,
    preview: args.preview,
    sms_test_actor_user_id: null,
    sms_test_manager_user_id: null,
    sms_test_session_id: null,
    test_workspace_id: null,
  };
  if (opts.includePortal) row.portal = args.portal ?? "manager";
  if (opts.includeSessionId && args.sessionId) row.session_id = args.sessionId;
  if (opts.includeProposalTraceId && args.proposalTraceId) row.proposal_trace_id = args.proposalTraceId;
  if (args.smsTestProvenance) {
    row.sms_test_actor_user_id = args.smsTestProvenance.actorUserId;
    row.sms_test_manager_user_id = args.smsTestProvenance.managerUserId;
    row.sms_test_session_id = args.smsTestProvenance.sessionId;
    row.test_workspace_id = args.smsTestProvenance.workspaceId ?? null;
  }
  if (args.expiresInMs && args.expiresInMs > 0) {
    row.expires_at = new Date(Date.now() + args.expiresInMs).toISOString();
  }
  return row;
}

type PendingActionInsertArgs = Parameters<typeof pendingActionInsertPayload>[0];

/**
 * Insert with bounded fallbacks for schema drift and optional FK columns.
 * Production once lacked `portal` / `session_id`; later deploys can race ahead
 * of `proposal_trace_id`. A stale client session id must not block the card.
 */
async function insertPendingActionRow(
  db: Db,
  args: PendingActionInsertArgs,
): Promise<{ id: string | null; lastError: DatabaseError | null }> {
  // Test actions must retain their durable test identity. Falling back to an
  // ordinary proposal during a rolling deploy would make it claimable outside
  // its authenticated SMS session.
  if (args.smsTestProvenance) {
    const { data, error } = await db.from("agent_pending_actions").insert(
      pendingActionInsertPayload(args, {
        includePortal: true,
        includeSessionId: true,
        includeProposalTraceId: true,
      }),
    ).select("id").single();
    return { id: !error && data?.id ? String(data.id) : null, lastError: error as DatabaseError | null };
  }
  const attempts: Array<{
    payload: Record<string, unknown>;
    label: string;
  }> = [
    {
      label: "full",
      payload: pendingActionInsertPayload(args, {
        includePortal: true,
        includeSessionId: true,
        includeProposalTraceId: true,
      }),
    },
    {
      label: "without proposal_trace_id",
      payload: pendingActionInsertPayload(args, {
        includePortal: true,
        includeSessionId: true,
        includeProposalTraceId: false,
      }),
    },
    {
      label: "without session_id",
      payload: pendingActionInsertPayload(args, {
        includePortal: true,
        includeSessionId: false,
        includeProposalTraceId: false,
      }),
    },
    {
      label: "without portal",
      payload: pendingActionInsertPayload(args, {
        includePortal: false,
        includeSessionId: false,
        includeProposalTraceId: false,
      }),
    },
  ];

  let lastError: DatabaseError | null = null;
  for (const attempt of attempts) {
    const { data, error } = await db.from("agent_pending_actions").insert(attempt.payload).select("id").single();
    if (!error && data?.id) {
      if (attempt.label !== "full") {
        console.warn("[agent] pending action insert succeeded after fallback", {
          tool: args.toolName,
          portal: args.portal ?? "manager",
          fallback: attempt.label,
        });
      }
      return { id: String(data.id), lastError: null };
    }
    lastError = (error as DatabaseError | null) ?? { message: "no row returned" };
    const recoverable =
      isForeignKeyViolation(error) ||
      isMissingColumn(error, "proposal_trace_id") ||
      isMissingColumn(error, "session_id") ||
      isMissingColumn(error, "portal");
    if (!recoverable) break;
  }
  return { id: null, lastError };
}

/** Which portal's registry + context resolver owns the action. */
export type AgentPortal = "manager" | "resident" | "vendor";

/**
 * Minimal actor surface for the claim. Every portal context satisfies it, as
 * does a bare `{ userId, db }` built from an authenticated session.
 */
export type PendingActionActor = {
  userId: string;
  db: Db;
};

/**
 * Insert a proposed action for a specific actor, service-role only. Used both by
 * the model-loop path (via {@link createPendingAction}) and by system-initiated
 * proposals that have no live AgentContext — e.g. the approval-first tour
 * confirmation generated when a new inquiry arrives on a public route. Those
 * async, inbox-style proposals pass a longer `expiresInMs` than a live chat
 * turn's 15-minute default.
 */
export async function createPendingActionForUser(
  db: Db,
  args: {
    landlordId: string;
    userId: string;
    toolName: string;
    input: unknown;
    preview: ActionPreview;
    portal?: AgentPortal;
    sessionId?: string | null;
    expiresInMs?: number;
    /**
     * Langfuse trace id of the turn that proposed this action. Server-owned —
     * never taken from the client. Null for system-initiated proposals (tours)
     * that have no chat turn to score against.
     */
    proposalTraceId?: string | null;
  },
): Promise<string | null> {
  const expiresInMs = args.expiresInMs && args.expiresInMs > 0 ? args.expiresInMs : CHAT_PENDING_ACTION_TTL_MS;
  const { id, lastError } = await insertPendingActionRow(db, {
    ...args,
    expiresInMs,
    smsTestProvenance: currentSmsTestProvenance(),
  });
  if (id) return id;
  // Never swallow this silently: a null here becomes the user-facing "could not
  // show the confirmation card" fallback, so the real reason (a schema drift, an
  // FK violation, RLS) must be diagnosable from the logs. Input/preview are
  // deliberately omitted — they can carry resident/applicant PII.
  console.error("[agent] pending action insert failed", {
    tool: args.toolName,
    portal: args.portal ?? "manager",
    error: lastError?.message ?? "no row returned",
    code: lastError?.code,
  });
  return null;
}

export async function createPendingAction(
  ctx: { landlordId?: string; userId: string; db: Db },
  toolName: string,
  input: unknown,
  preview: ActionPreview,
  opts: { portal?: AgentPortal; sessionId?: string | null; proposalTraceId?: string | null } = {},
): Promise<string | null> {
  return createPendingActionForUser(ctx.db, {
    landlordId: ctx.landlordId || ctx.userId,
    userId: ctx.userId,
    toolName,
    input,
    preview,
    portal: opts.portal,
    sessionId: opts.sessionId,
    proposalTraceId: opts.proposalTraceId,
    expiresInMs: CHAT_PENDING_ACTION_TTL_MS,
  });
}

export type ProposedAction = {
  id: string;
  input: unknown;
  preview: ActionPreview;
  createdAt: string;
};

/**
 * Every still-open proposal of one tool for one actor, newest first. Scoped on
 * `user_id` (the claim key) so a manager only ever sees their own approvals.
 */
export async function listProposedActionsForUser(
  db: Db,
  args: { userId: string; toolName: string },
): Promise<ProposedAction[]> {
  const smsTestProvenance = currentSmsTestProvenance();
  let query = db
    .from("agent_pending_actions")
    .select("id, input, preview, created_at")
    .eq("user_id", args.userId)
    .eq("tool_name", args.toolName)
    .eq("status", "proposed")
    .gt("expires_at", new Date().toISOString());
  if (smsTestProvenance) {
    query = query
      .eq("sms_test_actor_user_id", smsTestProvenance.actorUserId)
      .eq("sms_test_manager_user_id", smsTestProvenance.managerUserId)
      .eq("sms_test_session_id", smsTestProvenance.sessionId);
    query = smsTestProvenance.workspaceId
      ? query.eq("test_workspace_id", smsTestProvenance.workspaceId)
      : query.is("test_workspace_id", null);
  } else {
    query = query
      .is("sms_test_actor_user_id", null)
      .is("sms_test_manager_user_id", null)
      .is("sms_test_session_id", null);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as { id: string; input: unknown; preview: ActionPreview; created_at: string }[]).map((row) => ({
    id: String(row.id),
    input: row.input,
    preview: row.preview,
    createdAt: String(row.created_at ?? ""),
  }));
}

/** What a successful claim/deny hands the confirm gate. */
export type ClaimedAction = {
  toolName: string;
  input: unknown;
  portal: AgentPortal;
  sessionId: string | null;
  /** Langfuse proposal-turn id, when the proposing chat turn was traced. */
  proposalTraceId: string | null;
  smsTestProvenance: SmsTestProvenance | null;
};

async function resolvePendingAction(
  actor: PendingActionActor,
  id: string,
  status: "executed" | "denied",
): Promise<ClaimedAction | null> {
  const actionId = String(id ?? "").trim();
  if (!actionId) return null;
  // Single atomic update: only a still-proposed, unexpired row owned by this
  // ACTOR flips. A concurrent double-confirm loses the race and gets null.
  // `user_id` (not `landlord_id`) is the ownership key: two residents of the
  // same manager share a landlord_id, so filtering on it alone would let one
  // confirm the other's pending action.
  const testProvenance = currentSmsTestProvenance();
  let claim = actor.db
    .from("agent_pending_actions")
    .update({ status, resolved_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("user_id", actor.userId)
    .eq("status", "proposed")
    .gt("expires_at", new Date().toISOString());
  if (testProvenance) {
    claim = claim
      .eq("sms_test_actor_user_id", testProvenance.actorUserId)
      .eq("sms_test_manager_user_id", testProvenance.managerUserId)
      .eq("sms_test_session_id", testProvenance.sessionId);
    claim = testProvenance.workspaceId
      ? claim.eq("test_workspace_id", testProvenance.workspaceId)
      : claim.is("test_workspace_id", null);
  } else {
    claim = claim
      .is("sms_test_actor_user_id", null)
      .is("sms_test_manager_user_id", null)
      .is("sms_test_session_id", null);
  }
  const { data, error } = await claim.select(
    "tool_name, input, portal, session_id, proposal_trace_id, sms_test_actor_user_id, sms_test_manager_user_id, sms_test_session_id, test_workspace_id",
  );
  const row = (data ?? [])[0] as
    | {
        tool_name: string;
        input: unknown;
        portal?: string | null;
        session_id?: string | null;
        proposal_trace_id?: string | null;
        sms_test_actor_user_id?: string | null;
        sms_test_manager_user_id?: string | null;
        sms_test_session_id?: string | null;
        test_workspace_id?: string | null;
      }
    | undefined;
  if (error || !row) return null;
  const rowProvenance = row.sms_test_actor_user_id && row.sms_test_manager_user_id && row.sms_test_session_id
    ? {
      actorUserId: String(row.sms_test_actor_user_id),
      managerUserId: String(row.sms_test_manager_user_id),
      sessionId: String(row.sms_test_session_id),
      ...(row.test_workspace_id ? { workspaceId: String(row.test_workspace_id) } : {}),
    }
    : null;
  if (
    Boolean(rowProvenance) !== Boolean(testProvenance) ||
    (rowProvenance !== null && !sameSmsTestProvenance(rowProvenance, testProvenance))
  ) return null;
  const portal = row.portal === "resident" || row.portal === "vendor" ? row.portal : "manager";
  return {
    toolName: String(row.tool_name),
    input: row.input,
    portal,
    sessionId: row.session_id ? String(row.session_id) : null,
    proposalTraceId: row.proposal_trace_id ? String(row.proposal_trace_id) : null,
    smsTestProvenance: rowProvenance,
  };
}

/** Claim a proposed action for execution. Null = unknown/foreign/expired/replayed. */
export function claimPendingAction(actor: PendingActionActor, id: string) {
  return resolvePendingAction(actor, id, "executed");
}

/**
 * Mark a proposed action as denied. Same guards as claiming. Returns the claimed
 * row (including `proposalTraceId`) so the caller can score the proposal
 * without a second round-trip; null when the deny did not stick.
 */
export async function denyPendingAction(
  actor: PendingActionActor,
  id: string,
): Promise<ClaimedAction | null> {
  return resolvePendingAction(actor, id, "denied");
}

/**
 * Record that a claimed action's execution threw, so the row doesn't falsely
 * read "executed". Deliberately NOT reverted to "proposed": a handler may have
 * partially executed, and re-running it must go through a fresh proposal.
 */
export async function markPendingActionFailed(actor: PendingActionActor, id: string): Promise<void> {
  await actor.db
    .from("agent_pending_actions")
    .update({ status: "failed" })
    .eq("id", id)
    .eq("user_id", actor.userId)
    .eq("status", "executed");
}

/**
 * What a peek could establish about a proposal. `unreadable` is NOT the same as
 * `missing`: a transient query failure must never read as "no such row", or the
 * confirm gate would skip its portal check and burn the row it was protecting.
 */
export type PeekedPendingAction =
  | { state: "found"; portal: AgentPortal; toolName: string; smsTestProvenance: SmsTestProvenance | null }
  | { state: "missing" }
  | { state: "unreadable" };

/**
 * Read a proposal's portal WITHOUT claiming it, so the confirm route can
 * resolve that portal's context (and fail closed) before burning the action.
 * Actor-scoped: a foreign id is indistinguishable from an unknown one.
 */
export async function peekPendingActionPortal(
  actor: PendingActionActor,
  id: string,
): Promise<PeekedPendingAction> {
  const { data, error } = await actor.db
    .from("agent_pending_actions")
    .select("portal, tool_name, sms_test_actor_user_id, sms_test_manager_user_id, sms_test_session_id, test_workspace_id")
    .eq("id", id)
    .eq("user_id", actor.userId)
    .maybeSingle();
  if (error) return { state: "unreadable" };
  if (!data) return { state: "missing" };
  const portal = data.portal === "resident" || data.portal === "vendor" ? data.portal : "manager";
  const smsTestProvenance = data.sms_test_actor_user_id && data.sms_test_manager_user_id && data.sms_test_session_id
    ? {
      actorUserId: String(data.sms_test_actor_user_id),
      managerUserId: String(data.sms_test_manager_user_id),
      sessionId: String(data.sms_test_session_id),
      ...(data.test_workspace_id ? { workspaceId: String(data.test_workspace_id) } : {}),
    }
    : null;
  return { state: "found", portal, toolName: String(data.tool_name), smsTestProvenance };
}
