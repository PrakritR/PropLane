import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type SmsProjectionRole = "prospect" | "resident" | "applicant" | "vendor" | "manager" | "admin" | "unknown";
export type SmsProjectionDirection = "inbound" | "outbound";
export type SmsProjectionIdentityKind = "phone" | "user" | "unresolved";

export type SmsProjectionCursor = { occurredAt: string; id: string };

export type SmsProjectionSummary = {
  id: string;
  ownerManagerUserId: string;
  counterpartyRole: SmsProjectionRole;
  workLineId: string | null;
  workLinePhone: string;
  identityKey: string;
  identityKind: SmsProjectionIdentityKind;
  counterpartyUserId: string | null;
  phone: string | null;
  legacyKey: string | null;
  lastBody: string;
  lastDirection: SmsProjectionDirection | null;
  lastEventAt: string | null;
  lastEventId: string | null;
  lastInboundAt: string | null;
  lastInboundEventId: string | null;
  count: number;
  metadata: Record<string, unknown>;
};

export type SmsProjectionTurn = {
  id: string;
  conversationId: string;
  sourceNamespace: string;
  sourceEventId: string;
  direction: SmsProjectionDirection;
  body: string;
  occurredAt: string;
  fromPhone: string | null;
  toPhone: string | null;
  sourceRef: Record<string, unknown>;
};

export type SmsProjectionViewState = {
  viewerUserId: string;
  conversationId: string;
  isArchived: boolean;
  readThroughAt: string | null;
  readThroughEventId: string | null;
  version: number;
};

export type SmsProjectionEventInput = {
  ownerManagerUserId: string;
  counterpartyRole: SmsProjectionRole;
  workLineId: string;
  /** Stable server-resolved identity. Do not switch phone identities to user IDs without source proof. */
  identityKey: string;
  identityKind: SmsProjectionIdentityKind;
  counterpartyUserId?: string | null;
  counterpartyPhone?: string | null;
  legacyConversationKey?: string | null;
  legacyThreadId?: string | null;
  sourceNamespace: string;
  sourceEventId: string;
  direction: SmsProjectionDirection;
  body: string;
  occurredAt: string;
  fromPhone?: string | null;
  toPhone?: string | null;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type SmsProjectionWriteResult = { conversationId: string; eventId: string; inserted: boolean; eventCount: number } | { skipped: "deleted" };

const SUMMARY_COLUMNS = "id,owner_manager_user_id,counterparty_role,work_line_id,identity_key,identity_kind,counterparty_user_id,counterparty_phone,work_line_phone,legacy_conversation_key,last_body,last_direction,last_event_at,last_event_id,last_inbound_at,last_inbound_event_id,event_count,metadata";

function mapSummary(row: Record<string, unknown>): SmsProjectionSummary {
  return {
    id: String(row.id),
    ownerManagerUserId: String(row.owner_manager_user_id),
    counterpartyRole: row.counterparty_role as SmsProjectionRole,
    workLineId: row.work_line_id == null ? null : String(row.work_line_id),
    workLinePhone: String(row.work_line_phone ?? ""),
    identityKey: String(row.identity_key),
    identityKind: row.identity_kind as SmsProjectionIdentityKind,
    counterpartyUserId: row.counterparty_user_id == null ? null : String(row.counterparty_user_id),
    phone: row.counterparty_phone == null ? null : String(row.counterparty_phone),
    legacyKey: row.legacy_conversation_key == null ? null : String(row.legacy_conversation_key),
    lastBody: String(row.last_body ?? ""),
    lastDirection: (row.last_direction as SmsProjectionDirection | null) ?? null,
    lastEventAt: row.last_event_at == null ? null : String(row.last_event_at),
    lastEventId: row.last_event_id == null ? null : String(row.last_event_id),
    lastInboundAt: row.last_inbound_at == null ? null : String(row.last_inbound_at),
    lastInboundEventId: row.last_inbound_event_id == null ? null : String(row.last_inbound_event_id),
    count: Number(row.event_count ?? 0),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {},
  };
}

function mapTurn(row: Record<string, unknown>): SmsProjectionTurn {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sourceNamespace: String(row.source_namespace),
    sourceEventId: String(row.source_event_id),
    direction: row.direction as SmsProjectionDirection,
    body: String(row.body),
    occurredAt: String(row.occurred_at),
    fromPhone: row.from_phone == null ? null : String(row.from_phone),
    toPhone: row.to_phone == null ? null : String(row.to_phone),
    sourceRef: row.source_ref && typeof row.source_ref === "object" ? row.source_ref as Record<string, unknown> : {},
  };
}

/** Resolve an active work-number epoch using exact server-owned owner+number evidence. */
export async function resolveSmsProjectionWorkLine(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; phoneNumber: string; occurredAt?: string },
): Promise<{ workLineId: string; phoneNumber: string; workspaceId: string | null } | null> {
  const owner = args.ownerManagerUserId.trim();
  const phone = args.phoneNumber.trim();
  if (!owner || !phone) return null;
  const occurredAt = args.occurredAt ? Date.parse(args.occurredAt) : Date.now();
  if (!Number.isFinite(occurredAt)) return null;
  const { data, error } = await db.from("manager_sms_numbers")
    .select("id,manager_user_id,phone_number,workspace_id,provision_state,requested_at,provisioned_at,released_at")
    .eq("phone_number", phone)
    .in("provision_state", ["active", "released"])
    .limit(100);
  if (error || !data) return null;
  // `manager_sms_numbers` retains released rows. Resolve the ownership epoch
  // using provider lifecycle timestamps so a later purchase of the same phone
  // cannot absorb the previous number's history.
  const rows = data as unknown as Record<string, unknown>[];
  const epochMatching = rows.filter((row) => {
    const start = Date.parse(String(row.provisioned_at ?? row.requested_at ?? ""));
    const end = row.released_at == null ? Number.POSITIVE_INFINITY : Date.parse(String(row.released_at));
    return Number.isFinite(start) && occurredAt >= start && occurredAt <= end;
  });
  const foreignWorkspaceIds = [...new Set(epochMatching
    .filter((row) => row.manager_user_id !== owner && row.workspace_id)
    .map((row) => String(row.workspace_id)))];
  const ownedWorkspaceIds = new Set<string>();
  if (foreignWorkspaceIds.length) {
    const { data: workspaces, error: workspaceError } = await db.from("portal_workspaces")
      .select("id").eq("owner_user_id", owner).in("id", foreignWorkspaceIds);
    if (workspaceError) return null;
    for (const workspace of workspaces ?? []) ownedWorkspaceIds.add(String(workspace.id));
  }
  const matching = epochMatching.filter((row) =>
    row.manager_user_id === owner || ownedWorkspaceIds.has(String(row.workspace_id ?? "")));
  if (matching.length !== 1) return null;
  const row = matching[0];
  return {
    workLineId: String(row.id),
    phoneNumber: String(row.phone_number),
    workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
  };
}

/** Atomically create/find the summary, dedupe the original event, update summary and bind safe legacy aliases. */
export async function projectOriginalEvent(
  db: SupabaseClient,
  input: SmsProjectionEventInput,
): Promise<SmsProjectionWriteResult> {
  const required = [input.ownerManagerUserId, input.workLineId, input.identityKey, input.sourceNamespace, input.sourceEventId];
  if (required.some((value) => !value.trim()) || typeof input.body !== "string" || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new Error("Invalid SMS projection event");
  }
  const { data, error } = await db.rpc("project_sms_conversation_event", {
    p_event: {
      ownerManagerUserId: input.ownerManagerUserId,
      counterpartyRole: input.counterpartyRole,
      workLineId: input.workLineId,
      identityKey: input.identityKey,
      identityKind: input.identityKind,
      counterpartyUserId: input.counterpartyUserId ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      legacyConversationKey: input.legacyConversationKey ?? null,
      legacyThreadId: input.legacyThreadId ?? null,
      sourceNamespace: input.sourceNamespace,
      sourceEventId: input.sourceEventId,
      direction: input.direction,
      body: input.body,
      occurredAt: input.occurredAt,
      fromPhone: input.fromPhone ?? null,
      toPhone: input.toPhone ?? null,
      sourceRef: input.sourceRef ?? {},
      metadata: input.metadata ?? {},
    },
  });
  if (error) {
    // Operational receipt/outbox writes remain durable. Record a projection-only
    // retry marker so the existing bounded recovery worker can repair this
    // view without calling Twilio or replaying a paid agent turn.
    await enqueueSmsProjectionRetry(db, input, error.code ?? "projection_error").catch(() => undefined);
    throw new Error(`SMS projection write failed: ${error.message}`);
  }
  const result = data as { conversationId?: string; turnId?: string; inserted?: boolean; eventCount?: number; skipped?: string } | null;
  if (result?.skipped === "deleted") return { skipped: "deleted" };
  if (!result?.conversationId || !result.turnId) throw new Error("SMS projection returned an invalid result");
  return {
    conversationId: result.conversationId,
    eventId: result.turnId,
    inserted: result.inserted === true,
    eventCount: Number(result.eventCount ?? 0),
  };
}

export type SmsProjectionRetry = {
  ownerManagerUserId: string;
  sourceNamespace: string;
  sourceEventId: string;
  event: SmsProjectionEventInput | SmsProjectionSourceIntent;
  attempts: number;
  nextAttemptAt: string;
  claimToken: string;
};

/** The receipt insert transaction owns this repair intent before routing runs. */
export type SmsProjectionSourceIntent = { sourceRef: { table: "sms_inbound_receipts" | "manager_sms_messages"; id: string } };

/** Persist a PII-bearing event payload only in the service-only retry queue. */
export async function enqueueSmsProjectionRetry(
  db: SupabaseClient,
  event: SmsProjectionEventInput,
  reasonCode = "projection_error",
): Promise<void> {
  const { error } = await db.from("sms_projection_pending").upsert({
    owner_manager_user_id: event.ownerManagerUserId,
    source_namespace: event.sourceNamespace,
    source_event_id: event.sourceEventId,
    event_payload: event,
    status: "pending",
    next_attempt_at: new Date().toISOString(),
    last_error_code: reasonCode.slice(0, 80),
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_manager_user_id,source_namespace,source_event_id", ignoreDuplicates: true });
  if (error) throw new Error(`Could not enqueue SMS projection retry: ${error.message}`);
}

/** A bounded batch for the existing SMS recovery worker. Claiming/leases remain owned by that worker. */
export async function listPendingSmsProjectionRetries(
  db: SupabaseClient,
  args: { limit?: number } = {},
): Promise<SmsProjectionRetry[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 25)));
  const { data, error } = await db.rpc("claim_sms_projection_retries", { p_limit: limit });
  if (error) throw new Error(`SMS projection retry query failed: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    ownerManagerUserId: String(row.owner_manager_user_id),
    sourceNamespace: String(row.source_namespace),
    sourceEventId: String(row.source_event_id),
    event: row.event_payload as SmsProjectionEventInput | SmsProjectionSourceIntent,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: String(row.next_attempt_at),
    claimToken: String(row.claim_token),
  }));
}

export async function finishSmsProjectionRetry(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; sourceNamespace: string; sourceEventId: string; claimToken: string; success: boolean; reasonCode?: string },
): Promise<void> {
  const { data, error } = await db.rpc("finish_sms_projection_retry", {
    p_owner: args.ownerManagerUserId,
    p_namespace: args.sourceNamespace,
    p_source_id: args.sourceEventId,
    p_claim_token: args.claimToken,
    p_success: args.success,
    p_error_code: args.reasonCode?.slice(0, 80) ?? null,
  });
  if (error) throw new Error(`SMS projection retry update failed: ${error.message}`);
  if (data !== true) throw new Error("SMS projection retry lease expired or was reclaimed");
}

/** Read state only for conversations already authorized by the calling route. */
export async function loadSmsProjectionViewStates(
  db: SupabaseClient,
  args: { viewerUserId: string; conversationIds: string[] },
): Promise<SmsProjectionViewState[]> {
  const ids = [...new Set(args.conversationIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await db.from("sms_projection_view_state")
    .select("viewer_user_id,conversation_id,is_archived,read_through_at,read_through_event_id,version")
    .eq("viewer_user_id", args.viewerUserId).in("conversation_id", ids);
  if (error) throw new Error(`SMS projection view state read failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    viewerUserId: String(row.viewer_user_id),
    conversationId: String(row.conversation_id),
    isArchived: row.is_archived === true,
    readThroughAt: row.read_through_at == null ? null : String(row.read_through_at),
    readThroughEventId: row.read_through_event_id == null ? null : String(row.read_through_event_id),
    version: Number(row.version),
  }));
}

/** Version-CAS update. Caller must reauthorize conversation visibility on each request. */
export async function updateSmsProjectionViewState(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; viewerUserId: string; conversationId: string; expectedVersion: number; isArchived: boolean; readThrough?: SmsProjectionCursor | null },
): Promise<number | null> {
  const { data, error } = await db.rpc("set_sms_projection_view_state", {
    p_owner: args.ownerManagerUserId,
    p_viewer: args.viewerUserId,
    p_conversation: args.conversationId,
    p_expected_version: args.expectedVersion,
    p_archived: args.isArchived,
    p_read_through_at: args.readThrough?.occurredAt ?? null,
    p_read_through_event_id: args.readThrough?.id ?? null,
  });
  if (error) throw new Error(`SMS projection view state update failed: ${error.message}`);
  return data == null ? null : Number(data);
}

/** Summary-only keyset page. The caller must authorize this owner and line scope first. */
export async function listSmsProjectionConversations(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; role?: SmsProjectionRole; workLineId?: string; before?: SmsProjectionCursor; limit?: number },
): Promise<{ items: SmsProjectionSummary[]; nextCursor: SmsProjectionCursor | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 40)));
  let query = db.from("sms_projection_conversations").select(SUMMARY_COLUMNS)
    .eq("owner_manager_user_id", args.ownerManagerUserId)
    .is("merged_into_id", null)
    .order("last_event_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(limit + 1);
  if (args.role) query = query.eq("counterparty_role", args.role);
  if (args.workLineId) query = query.eq("work_line_id", args.workLineId);
  if (args.before) query = query.or(`last_event_at.lt.${args.before.occurredAt},and(last_event_at.eq.${args.before.occurredAt},id.lt.${args.before.id})`);
  const { data, error } = await query;
  if (error) throw new Error(`SMS projection list failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(mapSummary);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && last?.lastEventAt ? { occurredAt: last.lastEventAt, id: last.id } : null,
  };
}

/** Fetch recent original turns for one conversation after verifying its owner. */
export async function getSmsProjectionTurns(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; conversationId: string; before?: SmsProjectionCursor; limit?: number },
): Promise<{ conversation: SmsProjectionSummary; turns: SmsProjectionTurn[]; nextCursor: SmsProjectionCursor | null }> {
  const { data: summary, error: summaryError } = await db.from("sms_projection_conversations")
    .select(SUMMARY_COLUMNS).eq("owner_manager_user_id", args.ownerManagerUserId).eq("id", args.conversationId).maybeSingle();
  if (summaryError || !summary) throw new Error("SMS projection conversation not found");
  const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 50)));
  let query = db.from("sms_projection_turns").select("id,conversation_id,source_namespace,source_event_id,direction,body,occurred_at,from_phone,to_phone,source_ref")
    .eq("conversation_id", args.conversationId).order("occurred_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (args.before) query = query.or(`occurred_at.lt.${args.before.occurredAt},and(occurred_at.eq.${args.before.occurredAt},id.lt.${args.before.id})`);
  const { data, error } = await query;
  if (error) throw new Error(`SMS projection turns failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(mapTurn);
  const last = page.at(-1);
  return {
    conversation: mapSummary(summary as Record<string, unknown>),
    turns: page,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}

/** Resolve a legacy pointer within the exact authorized owner/role/work-line scope. */
export async function resolveSmsProjectionAlias(
  db: SupabaseClient,
  args: { ownerManagerUserId: string; role: SmsProjectionRole; workLineId: string; aliasKind: "legacy_key" | "legacy_thread"; aliasValue: string },
): Promise<string | null> {
  const aliasValue = args.aliasValue.trim();
  if (!args.ownerManagerUserId || !args.workLineId || !aliasValue) return null;
  const { data, error } = await db.from("sms_projection_aliases").select("conversation_id")
    .eq("owner_manager_user_id", args.ownerManagerUserId).eq("counterparty_role", args.role)
    .eq("work_line_id", args.workLineId).eq("alias_kind", args.aliasKind).eq("alias_value", aliasValue).maybeSingle();
  return error || !data ? null : String(data.conversation_id);
}
