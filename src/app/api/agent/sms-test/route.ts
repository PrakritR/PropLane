import { NextResponse } from "next/server";

import { sanitizeChatMessages, lastUserText } from "@/lib/agent/chat-handler";
import {
  handleAgentChatHistoryDeleteRequest,
  handleAgentChatHistoryRequest,
} from "@/lib/agent/chat-history-route";
import { agentChatRateLimitResponse } from "@/lib/agent/pending-action-decision";
import { assistantResponse } from "@/lib/agent/assistant-stream";
import {
  resolveSmsTestContext,
  type SmsTestPortal,
} from "@/lib/agent/sms-test-context.server";
import { runSmsTestTurn, type SmsTestTurnResult } from "@/lib/agent/sms-test-runner.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveSmsTestAppOrigin } from "@/lib/app-url";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

type SmsTestWirePayload = {
  mode: SmsTestTurnResult["mode"];
  stage: SmsTestTurnResult["stage"];
  targetListingId: string | null;
  sessionId: string;
  effects: Array<Pick<SmsTestTurnResult["effects"][number], "kind" | "status" | "summary">>;
};

function requestScope(request: Request): { portal: SmsTestPortal; targetListingId: string } | null {
  const params = new URL(request.url).searchParams;
  const portal = params.get("portal");
  if (portal !== "manager" && portal !== "resident") return null;
  return { portal, targetListingId: params.get("targetListingId")?.trim() ?? "" };
}

async function authorizedContext(request: Request) {
  const scope = requestScope(request);
  if (!scope) return null;
  const context = await resolveSmsTestContext(scope);
  return context ? { scope, context } : null;
}

function historyScope(context: NonNullable<Awaited<ReturnType<typeof resolveSmsTestContext>>>) {
  return {
    sessionKind: context.sessionKind,
    managerUserId: context.managerUserId,
    smsTestMode: context.mode,
    workspaceId: context.capability.workspaceId,
  } as const;
}

export async function GET(request: Request) {
  try {
    const resolved = await authorizedContext(request);
    if (!resolved) return NextResponse.json({ error: "Not found." }, { status: 404, headers: PRIVATE_HEADERS });
    return handleAgentChatHistoryRequest(
      request,
      { userId: resolved.context.capability.actorUserId, db: createSupabaseServiceRoleClient() },
      resolved.context.mode === "manager" ? "manager" : "resident",
      historyScope(resolved.context),
    );
  } catch (error) {
    const unavailable = error instanceof Error && error.message.includes("unavailable");
    if (!unavailable) console.error("[agent/sms-test] history lookup failed", error);
    return NextResponse.json({ error: unavailable ? "Not found." : "Could not load SMS test conversations." }, {
      status: unavailable ? 404 : 503,
      headers: PRIVATE_HEADERS,
    });
  }
}

export async function DELETE(request: Request) {
  try {
    const resolved = await authorizedContext(request);
    if (!resolved) return NextResponse.json({ error: "Not found." }, { status: 404, headers: PRIVATE_HEADERS });
    return handleAgentChatHistoryDeleteRequest(
      request,
      { userId: resolved.context.capability.actorUserId, db: createSupabaseServiceRoleClient() },
      resolved.context.mode === "manager" ? "manager" : "resident",
      historyScope(resolved.context),
    );
  } catch (error) {
    const unavailable = error instanceof Error && error.message.includes("unavailable");
    if (!unavailable) console.error("[agent/sms-test] history delete failed", error);
    return NextResponse.json({ error: unavailable ? "Not found." : "Could not delete that SMS test conversation." }, {
      status: unavailable ? 404 : 503,
      headers: PRIVATE_HEADERS,
    });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    body = {};
  }

  try {
    const resolved = await authorizedContext(request);
    if (!resolved) return NextResponse.json({ error: "Not found." }, { status: 404, headers: PRIVATE_HEADERS });
    const { context } = resolved;
    const rateLimited = await agentChatRateLimitResponse(
      body,
      context.capability.actorUserId,
      context.mode === "manager" ? "manager" : "resident",
    );
    if (rateLimited) return rateLimited;

    const hasImages = Array.isArray(body.images) ? body.images.length > 0 : body.images != null;
    const hasDocuments = Array.isArray(body.documents) ? body.documents.length > 0 : body.documents != null;
    if (hasImages || hasDocuments || "confirmActionId" in body || "denyActionId" in body) {
      return NextResponse.json(
        { error: "SMS test messages are text only. Confirm or decline SMS actions by replying YES or NO." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    const messages = sanitizeChatMessages(body.messages, { maxMessages: 20, maxChars: 2_000 });
    if (messages.length === 0 || messages.at(-1)?.role !== "user") {
      return NextResponse.json({ error: "A user message is required." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId.trim()
      : null;
    const result = await runSmsTestTurn({
      context,
      message: lastUserText(messages),
      sessionId,
      appOrigin: resolveSmsTestAppOrigin(),
    });
    const smsTest: SmsTestWirePayload = {
      mode: result.mode,
      stage: result.stage,
      targetListingId: result.target?.listingId ?? null,
      sessionId: result.sessionId,
      effects: result.effects.map((effect) => ({
        kind: effect.kind,
        status: effect.status,
        summary: effect.summary,
      })),
    };
    const responsePayload = {
      reply: result.reply,
      toolTrace: result.toolTrace,
      sessionId: result.sessionId,
      ...(result.traceId ? { traceId: result.traceId } : {}),
      archiveSaved: true,
      smsTest,
    };
    const response = assistantResponse(request, responsePayload);
    response.headers.set(
      "Cache-Control",
      request.headers.get("accept")?.includes("text/event-stream")
        ? "private, no-store, no-transform"
        : "private, no-store",
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const unavailable = message.includes("unavailable") || message.includes("non-production database");
    const staleSession = /session is invalid|session.*does not match/i.test(message);
    if (!unavailable && !staleSession) console.error("[agent/sms-test] turn failed", error);
    return NextResponse.json({
      error: unavailable
        ? "Not found."
        : staleSession
          ? "This SMS test context changed. Start a new test conversation to continue."
          : "The SMS test turn could not be completed. Please try again.",
    }, { status: unavailable ? 404 : staleSession ? 409 : 503, headers: PRIVATE_HEADERS });
  }
}
