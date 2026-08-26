import type { SupabaseClient } from "@supabase/supabase-js";

export type SmsInboundRouteKind =
  | "manager_self_reply"
  | "resident_agent"
  | "leasing_agent"
  | "leasing_template";

export type SmsInboundReplay = {
  status: "processing" | "retryable" | "completed";
  routeKind: SmsInboundRouteKind | null;
  counterpartyUserId: string | null;
  agentSessionId: string | null;
  inboundAgentMessageId: string | null;
  assistantAgentMessageId: string | null;
  pendingActionId: string | null;
  turnTraceId: string | null;
  replyBody: string | null;
  outboxId: string | null;
};

export async function loadInboundReplay(
  db: SupabaseClient,
  messageSid: string,
): Promise<{ ok: true; receipt: SmsInboundReplay | null } | { ok: false }> {
  const { data, error } = await db
    .from("sms_inbound_receipts")
    .select(
      "status, route_kind, counterparty_user_id, agent_session_id, inbound_agent_message_id, assistant_agent_message_id, pending_action_id, turn_trace_id, reply_body, outbox_id",
    )
    .eq("message_sid", messageSid)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, receipt: null };
  return {
    ok: true,
    receipt: {
      status: data.status as SmsInboundReplay["status"],
      routeKind: (data.route_kind as SmsInboundRouteKind | null) ?? null,
      counterpartyUserId: data.counterparty_user_id ?? null,
      agentSessionId: data.agent_session_id ?? null,
      inboundAgentMessageId: data.inbound_agent_message_id ?? null,
      assistantAgentMessageId: data.assistant_agent_message_id ?? null,
      pendingActionId: data.pending_action_id ?? null,
      turnTraceId: data.turn_trace_id ?? null,
      replyBody: data.reply_body ?? null,
      outboxId: data.outbox_id ?? null,
    },
  };
}

export async function prepareInboundReply(
  db: SupabaseClient,
  args: {
    messageSid: string;
    workerId: string;
    routeKind: SmsInboundRouteKind;
    replyBody: string;
    counterpartyUserId?: string | null;
    agentSessionId?: string | null;
    inboundAgentMessageId?: string | null;
    assistantAgentMessageId?: string | null;
    pendingActionId?: string | null;
    turnTraceId?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await db.rpc("prepare_sms_inbound_reply", {
    p_message_sid: args.messageSid,
    p_worker_id: args.workerId,
    p_route_kind: args.routeKind,
    p_counterparty_user_id: args.counterpartyUserId ?? null,
    p_agent_session_id: args.agentSessionId ?? null,
    p_inbound_agent_message_id: args.inboundAgentMessageId ?? null,
    p_assistant_agent_message_id: args.assistantAgentMessageId ?? null,
    p_pending_action_id: args.pendingActionId ?? null,
    p_turn_trace_id: args.turnTraceId ?? null,
    p_reply_body: args.replyBody,
  });
  return !error && data === true;
}

export async function attachInboundOutbox(
  db: SupabaseClient,
  args: { messageSid: string; workerId: string; outboxId: string },
): Promise<boolean> {
  const { data, error } = await db.rpc("attach_sms_inbound_outbox", {
    p_message_sid: args.messageSid,
    p_worker_id: args.workerId,
    p_outbox_id: args.outboxId,
  });
  return !error && data === true;
}

export async function finishInboundClaim(
  db: SupabaseClient,
  messageSid: string,
  workerId: string,
  status: "retryable" | "completed",
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("sms_inbound_receipts")
    .update({
      status,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: status === "completed" ? now : null,
      updated_at: now,
    })
    .eq("message_sid", messageSid)
    .eq("lease_owner", workerId)
    .eq("status", "processing")
    .select("message_sid")
    .maybeSingle();
  return !error && Boolean(data);
}
