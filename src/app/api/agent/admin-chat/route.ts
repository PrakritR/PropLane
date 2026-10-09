import { NextResponse } from "next/server";
import { assistantContextHintFromRequest, withAssistantTaskContext } from "@/lib/agent/assistant-turn-context";
import { adminSessionActor, resolveAdminAgentContext } from "@/lib/tools/admin/context";
import { adminAgentRegistry } from "@/lib/tools/admin";
import { runAgentTurn } from "@/lib/agent/loop";
import { ADMIN_PORTAL_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { sanitizeChatMessages, lastUserText } from "@/lib/agent/chat-handler";
import { agentChatRateLimitResponse } from "@/lib/agent/pending-action-decision";
import { ensureAgentSession, appendAgentMessages } from "@/lib/agent/sessions";
import { handleAgentChatHistoryDeleteRequest, handleAgentChatHistoryRequest } from "@/lib/agent/chat-history-route";
import { MODAL_CHAT_SESSION_KIND, PORTAL_CHAT_SESSION_KIND } from "@/lib/agent/chat-history";
import { loadAgentCustomInstructions, withAgentCustomInstructions } from "@/lib/agent/user-preferences";
import { track } from "@/lib/analytics/posthog";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { formatAgentChatUserError } from "@/lib/agent/assistant-turn-error";
import { selectPortalAgentRoute, fastLaneRunOptions, type AgentRouteSelection } from "@/lib/agent/model";
import { assistantResponse } from "@/lib/agent/assistant-stream";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Admin archive, pinned to the signed-in operator. A non-admin is a 401, never a 403. */
export async function GET(req: Request) {
  const ctx = await resolveAdminAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return handleAgentChatHistoryRequest(req, ctx, "admin");
}

export async function DELETE(req: Request) {
  const ctx = await resolveAdminAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return handleAgentChatHistoryDeleteRequest(req, ctx, "admin");
}

/**
 * Admin-console assistant turn. Same loop and tracing as the other portal
 * chats, against the admin registry: READ tools only, so there is no pending
 * action, no confirm path and no communication-credit reservation (nothing here
 * sends a message or calls a model on a customer's behalf). The context comes
 * from `resolveAdminAgentContext` (admin role re-derived on every request) and
 * never from the manager resolver, so this route can not answer from the
 * operator's own manager workspace.
 */
export async function POST(req: Request) {
  const ctx = await resolveAdminAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    body = {};
  }

  const limited = await agentChatRateLimitResponse(body, ctx.userId, "admin");
  if (limited) return limited;

  const messages = sanitizeChatMessages(body.messages);
  if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
    return NextResponse.json({ error: "A user message is required." }, { status: 400 });
  }

  const contextHint = assistantContextHintFromRequest(body.contextHint, messages);
  const visibleUserText = lastUserText(messages);
  const actor = adminSessionActor(ctx);

  const sessionKind = body.archive === false ? MODAL_CHAT_SESSION_KIND : PORTAL_CHAT_SESSION_KIND;
  const sessionId = await ensureAgentSession(actor, "admin", {
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    title: visibleUserText,
    kind: sessionKind,
  });
  if (sessionKind === PORTAL_CHAT_SESSION_KIND && !sessionId) {
    return NextResponse.json(
      { error: "We couldn't start a saved conversation. Please try again." },
      { status: 503 },
    );
  }
  const customInstructions = await loadAgentCustomInstructions(ctx.db, ctx.userId);

  try {
    const system = withAssistantTaskContext(withAgentCustomInstructions(ADMIN_PORTAL_SYSTEM_PROMPT, customInstructions), contextHint);
    const promptMeta = resolvePromptMeta(PROMPT_IDS.adminAssistant, system);
    const traceActor = {
      userId: ctx.userId,
      sessionId: sessionId ?? undefined,
      metadata: { role: "admin", isAdmin: true },
    };
    let traceId: string | null = null;
    const routing: AgentRouteSelection = selectPortalAgentRoute({
      messages: contextHint ? [...messages.slice(0, -1), { role: "user", content: `[Context: ${contextHint}]\n\n${visibleUserText}` }] : messages,
      actorKey: ctx.userId,
      availableTools: [...adminAgentRegistry.keys()],
    });
    const result = await traceAgentTurn(
      traceActor,
      messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "[image message]" })),
      (observer) =>
        runAgentTurn({
          ctx,
          registry: adminAgentRegistry,
          system,
          messages,
          observer,
          model: routing,
          ...fastLaneRunOptions(routing),
        }),
      { onTraceId: (id) => (traceId = id), promptMeta },
    );
    track("assistant_message_sent", ctx.userId, {
      portal: "admin",
      tools: result.toolTrace.length,
      model: result.model,
      tier: result.tier,
      provider: result.provider,
      route: result.route,
      reasoningEffort: result.reasoningEffort ?? "none",
      fallback: Boolean(result.fallbackReason),
      latencyMs: result.latencyMs,
      promptId: promptMeta.promptId,
      promptHash: promptMeta.promptHash,
    });

    const reply = result.reply;
    const archiveSaved = await appendAgentMessages(actor, "admin", sessionId, [
      { role: "user", content: visibleUserText },
      {
        role: "assistant",
        content: reply,
        toolTrace: {
          tools: result.toolTrace,
          model: result.model,
          tier: result.tier,
          provider: result.provider,
          route: result.route,
          fallback: Boolean(result.fallbackReason),
          latencyMs: result.latencyMs,
          promptId: promptMeta.promptId,
          promptHash: promptMeta.promptHash,
          release: promptMeta.release,
          ...(traceId ? { traceId } : {}),
        },
      },
    ], { kind: sessionKind });

    return assistantResponse(req, {
      reply,
      toolTrace: result.toolTrace,
      sessionId,
      ...(traceId ? { traceId } : {}),
      ...(sessionKind === PORTAL_CHAT_SESSION_KIND ? { archiveSaved } : {}),
    });
  } catch (e) {
    console.error("[agent/admin-chat] turn failed:", e);
    const { message, httpStatus } = formatAgentChatUserError(e);
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
