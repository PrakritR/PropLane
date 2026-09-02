import { NextResponse } from "next/server";
import { resolveVendorAgentContext } from "@/lib/tools/vendor-context";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import { runAgentTurn } from "@/lib/agent/loop";
import type { ActionPreview } from "@/lib/tools/registry";
import { VENDOR_PORTAL_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { sanitizeChatMessages, lastUserText, applyChatAttachments } from "@/lib/agent/chat-handler";
import { createPendingAction } from "@/lib/tools/pending-actions";
import { handlePendingActionDecision } from "@/lib/agent/pending-action-decision";
import { ensureAgentSession, appendAgentMessages } from "@/lib/agent/sessions";
import { handleAgentChatHistoryDeleteRequest, handleAgentChatHistoryRequest } from "@/lib/agent/chat-history-route";
import { MODAL_CHAT_SESSION_KIND, PORTAL_CHAT_SESSION_KIND } from "@/lib/agent/chat-history";
import { loadAgentCustomInstructions, withAgentCustomInstructions } from "@/lib/agent/user-preferences";
import { rateLimit } from "@/lib/rate-limit";
import { track } from "@/lib/analytics/posthog";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import {
  formatAgentChatUserError,
  PENDING_ACTION_SAVE_FAILED_NOTE,
} from "@/lib/agent/assistant-turn-error";
import { messagesNeedVisionModel, visionPinnedModel } from "@/lib/agent/assistant-vision-turn";
import { selectAgentRoute, fastLaneRunOptions, type AgentRouteSelection } from "@/lib/agent/model";
import { assistantResponse } from "@/lib/agent/assistant-stream";

export const runtime = "nodejs";

/** Vendor archive, pinned to the signed-in vendor rather than a shared manager. */
export async function GET(req: Request) {
  const ctx = await resolveVendorAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return handleAgentChatHistoryRequest(req, ctx, "vendor");
}

export async function DELETE(req: Request) {
  const ctx = await resolveVendorAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return handleAgentChatHistoryDeleteRequest(req, ctx, "vendor");
}

/**
 * Vendor-portal assistant turn. Same loop and gating as the manager chat,
 * against the vendor-scoped registry: every tool self-scopes to the
 * authenticated vendor's own records, and write proposals only execute when
 * the user posts the action id back to THIS endpoint (the one confirm gate,
 * portal-bound to "vendor"). There is no separate confirm route.
 */
export async function POST(req: Request) {
  const ctx = await resolveVendorAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (!rateLimit(`vendor-chat:${ctx.userId}`, 20, 300_000).ok) {
    return NextResponse.json(
      { error: "You're sending messages a little fast — please wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Confirm / deny of an earlier proposal: the body carries ONLY the action id.
  // The stored input is re-validated and the handler re-resolves state itself.
  const decision = await handlePendingActionDecision({
    body,
    ctx,
    registry: vendorAgentRegistry,
    portal: "vendor",
    traceMetadata: { role: "vendor", managerIds: ctx.managerIds },
  });
  if (decision) return decision;

  let messages = sanitizeChatMessages(body.messages);
  if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
    return NextResponse.json({ error: "A user message is required." }, { status: 400 });
  }

  const attached = applyChatAttachments(messages, body);
  if (!attached.ok) return NextResponse.json({ error: attached.error }, { status: 400 });
  messages = attached.messages;

  const sessionKind = body.archive === false ? MODAL_CHAT_SESSION_KIND : PORTAL_CHAT_SESSION_KIND;
  const sessionId = await ensureAgentSession(ctx, "vendor", {
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    title: lastUserText(messages),
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
    const system = withAgentCustomInstructions(VENDOR_PORTAL_SYSTEM_PROMPT, customInstructions);
    const promptMeta = resolvePromptMeta(PROMPT_IDS.vendorAssistant, system);
    const traceActor = {
      userId: ctx.userId,
      sessionId: sessionId ?? undefined,
      metadata: { role: "vendor", managerIds: ctx.managerIds },
    };
    let traceId: string | null = null;
    const hasVision = messagesNeedVisionModel(messages);
    const routing: AgentRouteSelection = hasVision
      ? visionPinnedModel()
      : selectAgentRoute({
          messages,
          actorKey: ctx.userId,
          availableTools: [...vendorAgentRegistry.keys()],
        });
    const result = await traceAgentTurn(
      traceActor,
      messages.map((m) => ({ role: m.role, content: String(m.content) })),
      (observer) =>
        runAgentTurn({
          ctx,
          registry: vendorAgentRegistry,
          system,
          messages,
          observer,
          model: routing,
          ...fastLaneRunOptions(routing),
        }),
      { onTraceId: (id) => (traceId = id), promptMeta },
    );
    track("assistant_message_sent", ctx.userId, {
      portal: "vendor",
      tools: result.toolTrace.length,
      model: result.model,
      tier: result.tier,
      provider: result.provider,
      route: result.route,
      fallback: Boolean(result.fallbackReason),
      latencyMs: result.latencyMs,
      images: attached.imageCount,
      documents: attached.documentCount,
      promptId: promptMeta.promptId,
      promptHash: promptMeta.promptHash,
    });

    // A proposal is persisted server-side; the client only ever receives the
    // opaque id and the preview it can confirm or deny. The stored input never
    // leaves the server.
    const proposal = result.pendingAction;
    let pendingAction: { id: string; preview: ActionPreview } | null = null;
    let reply = result.reply;
    if (proposal) {
      const actionId = await createPendingAction(ctx, proposal.toolName, proposal.input, proposal.preview, {
        portal: "vendor",
        sessionId,
        proposalTraceId: traceId,
      });
      if (actionId) {
        pendingAction = { id: actionId, preview: proposal.preview };
        track("assistant_action_proposed", ctx.userId, {
          portal: "vendor",
          tool: proposal.toolName,
          batch: proposal.preview.batchCount ?? 1,
        });
      } else {
        reply = reply.trim() ? `${reply.trim()}\n\n${PENDING_ACTION_SAVE_FAILED_NOTE}` : PENDING_ACTION_SAVE_FAILED_NOTE;
      }
    }

    const archiveSaved = await appendAgentMessages(ctx, "vendor", sessionId, [
      { role: "user", content: lastUserText(messages) },
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
          ...(proposal && pendingAction
            ? { pendingAction: { id: pendingAction.id, toolName: proposal.toolName } }
            : proposal
              ? { pendingAction: { toolName: proposal.toolName } }
              : {}),
        },
      },
    ], { kind: sessionKind });

    return assistantResponse(req, {
      reply,
      toolTrace: result.toolTrace,
      sessionId,
      ...(traceId ? { traceId } : {}),
      ...(sessionKind === PORTAL_CHAT_SESSION_KIND ? { archiveSaved } : {}),
      ...(pendingAction ? { pendingAction } : {}),
    });
  } catch (e) {
    console.error("[agent/vendor-chat] turn failed:", e);
    const { message, httpStatus } = formatAgentChatUserError(e);
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
