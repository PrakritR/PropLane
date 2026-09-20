import "server-only";

import {
  findOrCreateLeasingSmsTestSession,
  runLeasingSmsAgentTurn,
} from "@/lib/agent/leasing-sms-agent.server";
import { runManagerSmsAgentTurn } from "@/lib/agent/manager-sms-agent.server";
import { runResidentSmsAgentTurn } from "@/lib/agent/resident-sms-agent.server";
import { findOrCreateSmsAgentTestSession } from "@/lib/agent/sms-agent-turn.server";
import {
  assertSmsTestEnvironment,
  type SmsTestApplicationStage,
  type SmsTestMode,
  type SmsTestResolvedContext,
  type SmsTestTarget,
} from "@/lib/agent/sms-test-context.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { classifySmsConfirmationReply } from "@/lib/sms/agent-confirmation.server";
import {
  completeSmsTestBurst,
  recordAndClaimSmsTestBurst,
} from "@/lib/sms/sms-test-burst.server";
import {
  runWithSmsTestTransport,
  type SmsTestCapturedEffect,
} from "@/lib/sms/sms-test-transport.server";

export type SmsTestTurnResult = {
  reply: string;
  toolTrace: { tool: string; ok: boolean }[];
  sessionId: string;
  traceId?: string | null;
  effects: SmsTestCapturedEffect[];
  mode: SmsTestMode;
  stage: SmsTestApplicationStage;
  target: SmsTestTarget | null;
};

async function sessionIdForCurrentStage(
  context: SmsTestResolvedContext,
  suppliedSessionId: string | null | undefined,
  message: string,
): Promise<{ sessionId?: string; crossedModeConfirmation: boolean }> {
  const sessionId = suppliedSessionId?.trim();
  if (!sessionId || context.mode === "manager") return { sessionId, crossedModeConfirmation: false };
  if (!context.target) throw new Error("SMS test target is unavailable.");
  const db = context.residentContext?.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db.from("agent_sessions")
    .select("id,kind,status,user_id,landlord_id,test_actor_user_id,sms_test_manager_user_id,sms_test_mode,sms_test_target_listing_id,test_workspace_id")
    .eq("id", sessionId)
    .eq("status", "active")
    .eq("user_id", context.capability.actorUserId)
    .eq("test_actor_user_id", context.capability.actorUserId)
    .eq("landlord_id", context.managerUserId)
    .eq("sms_test_manager_user_id", context.managerUserId)
    .eq("sms_test_target_listing_id", context.target.listingId)
    .eq("test_workspace_id", context.capability.workspaceId)
    .maybeSingle();
  if (error || !data) throw new Error("The SMS test session is invalid for this conversation.");
  if (data.sms_test_mode === context.mode && data.kind === context.sessionKind) {
    return { sessionId, crossedModeConfirmation: false };
  }
  if (!['prospect', 'resident'].includes(String(data.sms_test_mode))) {
    throw new Error("The SMS test session is invalid for this conversation.");
  }
  return {
    sessionId: undefined,
    crossedModeConfirmation: classifySmsConfirmationReply(message) !== "none",
  };
}

async function persistStageTransitionReply(
  context: SmsTestResolvedContext,
  message: string,
): Promise<{ sessionId: string; reply: string }> {
  if (!context.target || context.mode === "manager") throw new Error("SMS test stage transition is invalid.");
  const db = context.residentContext?.db ?? createSupabaseServiceRoleClient();
  const session = context.mode === "prospect"
    ? await findOrCreateLeasingSmsTestSession(db, {
        landlordId: context.managerUserId,
        actorUserId: context.capability.actorUserId,
        targetListingId: context.target.listingId,
        sessionKind: context.sessionKind,
      })
    : await findOrCreateSmsAgentTestSession(db, {
        kind: context.sessionKind,
        managerUserId: context.managerUserId,
        actorUserId: context.capability.actorUserId,
        mode: "resident",
        portal: "resident",
        targetListingId: context.target.listingId,
      });
  if (!session) throw new Error("Could not create the current SMS test session.");
  const reply = "Your application stage changed, so I did not apply that confirmation to the earlier conversation. Send your request again to continue in the current stage.";
  const { error } = await db.from("agent_messages").insert([
    { session_id: session.id, landlord_id: context.managerUserId, role: "user", content: message, channel: "sms" },
    { session_id: session.id, landlord_id: context.managerUserId, role: "assistant", content: reply, channel: "agent", tool_trace: [] },
  ]);
  if (error) throw new Error("Could not save the SMS test stage transition.");
  return { sessionId: session.id, reply };
}

/**
 * Runs one authenticated in-app SMS turn through the same role registry and
 * persisted session machinery as carrier SMS. The resolved context is the
 * authorization boundary; route input never supplies a manager or actor id.
 */
export async function runSmsTestTurn(args: {
  context: SmsTestResolvedContext;
  message: string;
  sessionId?: string | null;
  appOrigin: string;
}): Promise<SmsTestTurnResult> {
  assertSmsTestEnvironment();
  const message = args.message.trim().slice(0, 2_000);
  if (!message) throw new Error("An SMS test message is required.");
  const stageSession = await sessionIdForCurrentStage(args.context, args.sessionId, message);
  if (stageSession.crossedModeConfirmation) {
    const transition = await persistStageTransitionReply(args.context, message);
    return {
      reply: transition.reply,
      toolTrace: [],
      sessionId: transition.sessionId,
      effects: [],
      mode: args.context.mode,
      stage: args.context.stage,
      target: args.context.target,
    };
  }

  const db = args.context.managerContext?.db ?? args.context.residentContext?.db ?? createSupabaseServiceRoleClient();
  const session = args.context.mode === "prospect"
    ? args.context.target && await findOrCreateLeasingSmsTestSession(db, {
        landlordId: args.context.managerUserId,
        actorUserId: args.context.capability.actorUserId,
        targetListingId: args.context.target.listingId,
        sessionKind: args.context.sessionKind,
        sessionId: stageSession.sessionId,
      })
    : await findOrCreateSmsAgentTestSession(db, {
        kind: args.context.sessionKind,
        managerUserId: args.context.managerUserId,
        actorUserId: args.context.capability.actorUserId,
        mode: args.context.mode,
        portal: args.context.capability.portal,
        sessionId: stageSession.sessionId,
        targetListingId: args.context.target?.listingId ?? null,
      });
  if (!session) throw new Error("The SMS test session is invalid.");

  const identity = {
    actorUserId: args.context.capability.actorUserId,
    managerUserId: args.context.managerUserId,
    sessionId: session.id,
    workspaceId: args.context.capability.workspaceId,
    appOrigin: args.appOrigin,
  };

  if (args.context.mode === "manager") {
    if (!args.context.managerContext) throw new Error("Manager SMS test context is unavailable.");
    const captured = await runWithSmsTestTransport(identity, () => runManagerSmsAgentTurn(
      args.context.managerContext!.db,
      {
        ctx: args.context.managerContext!,
        inboundText: message,
        testActor: {
          userId: args.context.capability.actorUserId,
          managerUserId: args.context.managerUserId,
          sessionKind: args.context.sessionKind,
          sessionId: session.id,
        },
      },
    ));
    if (!captured.result) throw new Error("The manager SMS test turn did not produce a reply.");
    return turnResult(args.context, captured.result, captured.effects);
  }

  if (args.context.mode === "resident") {
    if (!args.context.residentContext) throw new Error("Resident SMS test context is unavailable.");
    const target = args.context.target;
    if (!target) throw new Error("Resident SMS test target is unavailable.");
    const captured = await runWithSmsTestTransport(identity, () => runResidentSmsAgentTurn(
      args.context.residentContext!.db,
      {
        ctx: args.context.residentContext!,
        ownerManagerUserId: args.context.managerUserId,
        inboundText: message,
        testActor: {
          userId: args.context.capability.actorUserId,
          managerUserId: args.context.managerUserId,
          targetListingId: target.listingId,
          sessionKind: args.context.sessionKind,
          sessionId: session.id,
        },
      },
    ));
    if (!captured.result) throw new Error("The resident SMS test turn did not produce a reply.");
    return turnResult(args.context, captured.result, captured.effects);
  }

  const target = args.context.target;
  if (!target) throw new Error("Prospect SMS test target is unavailable.");
  const claimed = await recordAndClaimSmsTestBurst(db, {
    managerUserId: args.context.managerUserId,
    actorUserId: args.context.capability.actorUserId,
    sessionId: session.id,
    body: message,
  });
  if (!claimed) throw new Error("The prospect SMS test turn could not be claimed.");

  const captured = await runWithSmsTestTransport(identity, () => runLeasingSmsAgentTurn(db, {
    landlordId: args.context.managerUserId,
    inboundText: message,
    inboundMessageSid: claimed.sourceMessageId,
    crossCatalog: false,
    prospectBurst: {
      burstId: claimed.burstId,
      revision: claimed.revision,
      workerId: claimed.workerId,
      claimedSourceIds: claimed.sourceIds,
      testSessionId: session.id,
    },
    testActor: {
      userId: args.context.capability.actorUserId,
      email: args.context.actorEmail,
      targetListingId: target.listingId,
      sessionKind: args.context.sessionKind,
      sessionId: session.id,
    },
    testTarget: {
      listingId: target.listingId,
      title: target.title,
    },
  }));
  const turn = captured.result;
  if (!turn) throw new Error("The prospect SMS test turn did not produce a reply.");
  const completed = await completeSmsTestBurst(db, {
    ...claimed,
    actorUserId: args.context.capability.actorUserId,
    reply: turn.reply,
    candidateContext: turn.candidateContext,
  });
  if (!completed) throw new Error("The prospect SMS test reply could not be committed.");
  return turnResult(args.context, turn, captured.effects);
}

function turnResult(
  context: SmsTestResolvedContext,
  turn: { reply: string; sessionId: string; traceId?: string | null; toolTrace?: { tool: string; ok: boolean }[] },
  effects: SmsTestCapturedEffect[],
): SmsTestTurnResult {
  return {
    reply: turn.reply,
    toolTrace: turn.toolTrace ?? [],
    sessionId: turn.sessionId,
    traceId: turn.traceId,
    effects,
    mode: context.mode,
    stage: context.stage,
    target: context.target,
  };
}
