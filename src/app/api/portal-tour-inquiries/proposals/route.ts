import { NextResponse } from "next/server";
import { resolveAgentContext } from "@/lib/tools/context";
import { denyPendingAction, listProposedActionsForUser } from "@/lib/tools/pending-actions";
import { runConfirmedPendingAction } from "@/lib/tools/confirm-gate.server";
import { CONFIRM_TOUR_INQUIRY_TOOL } from "@/lib/tour-proposal.server";
import { track } from "@/lib/analytics/posthog";
import { scoreActionApproval } from "@/lib/observability/langfuse";
import { INQUIRY_EVENT_RECORD_TYPE, payloadFromScheduleRecord } from "@/lib/tour-inquiry-create.server";
import { tourInquirySummaryForProposal } from "@/lib/manager-tour-proposal-rows";

export const runtime = "nodejs";

/**
 * The standalone approval surface for approval-first automated tours. It reuses
 * `agent_pending_actions` and the same confirm gate the assistant uses: GET
 * lists the manager's open tour proposals; POST approves (runs the gated
 * `confirm_tour_inquiry` handler) or discards (denies the proposal). Nothing
 * books or emails the tenant until the manager approves here.
 */
export async function GET() {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const actions = await listProposedActionsForUser(ctx.db, {
    userId: ctx.userId,
    toolName: CONFIRM_TOUR_INQUIRY_TOOL,
  });
  const proposalInput = (action: (typeof actions)[number]): Record<string, unknown> =>
    action.input && typeof action.input === "object" && !Array.isArray(action.input)
      ? (action.input as Record<string, unknown>)
      : {};
  const openInquiryIds = [
    ...new Set(
      actions
        .map((action) => (typeof proposalInput(action).inquiryId === "string" ? String(proposalInput(action).inquiryId).trim() : ""))
        .filter(Boolean),
    ),
  ];
  // The proposal card is the manager's own request, so the contact + house facts of THAT inquiry travel with it: a row
  // built from the preview alone has no email or phone (the Tours list then showed "Prospect" / "Property" and the confirm
  // message had no recipient). Read the manager's OWN rows for exactly these inquiries (`loadManagerTourBlocks` reads the
  // same ones), never the platform-wide inquiry blob: that single row carries every workspace's prospects.
  const inquiryById = new Map<string, Record<string, unknown>>();
  if (openInquiryIds.length > 0) {
    try {
      const { data } = await ctx.db
        .from("portal_schedule_records")
        .select("row_data")
        .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
        .eq("manager_user_id", ctx.userId)
        .in("row_data->payload->>id", openInquiryIds);
      for (const row of (data ?? []) as { row_data?: unknown }[]) {
        const payload = payloadFromScheduleRecord(row.row_data);
        if (payload && typeof payload.id === "string") inquiryById.set(payload.id, payload);
      }
    } catch {
      /* the preview fields still render the row */
    }
  }
  // Expose only the inquiry id + slot times + the contact summary from stored input — never the full payload.
  return NextResponse.json({
    proposals: actions.map((action) => {
      const input = proposalInput(action);
      const inquiryId = typeof input.inquiryId === "string" ? input.inquiryId.trim() : "";
      const startIso = typeof input.start === "string" ? input.start.trim() : "";
      const endIso = typeof input.end === "string" ? input.end.trim() : "";
      return {
        id: action.id,
        inquiryId,
        startIso,
        endIso,
        preview: action.preview,
        inquiry: tourInquirySummaryForProposal(inquiryById.get(inquiryId)),
        createdAt: action.createdAt,
      };
    }),
  });
}

export async function POST(req: Request) {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const actionId = typeof body.actionId === "string" ? body.actionId.trim() : "";
  const decision = typeof body.decision === "string" ? body.decision : "";
  if (!actionId || (decision !== "approve" && decision !== "discard")) {
    return NextResponse.json({ error: "actionId and decision (approve|discard) required." }, { status: 400 });
  }

  if (decision === "discard") {
    const denied = await denyPendingAction(ctx, actionId);
    track("assistant_action_denied", ctx.userId, {
      known: !!denied,
      action: CONFIRM_TOUR_INQUIRY_TOOL,
    });
    // Tour proposals are system-initiated and usually have no proposal trace;
    // scoring is a no-op when proposalTraceId is null.
    if (denied?.proposalTraceId) {
      await scoreActionApproval({
        traceId: denied.proposalTraceId,
        approved: false,
        actionId,
        toolName: denied.toolName,
      });
    }
    return NextResponse.json({ ok: true, reply: "Proposal discarded. Nothing was booked or sent." });
  }

  const result = await runConfirmedPendingAction(ctx, actionId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  track("assistant_action_confirmed", ctx.userId, { action: result.toolName });
  if (result.proposalTraceId) {
    await scoreActionApproval({
      traceId: result.proposalTraceId,
      approved: true,
      actionId,
      toolName: result.toolName,
    });
  }
  return NextResponse.json({ ok: true, reply: result.reply });
}
