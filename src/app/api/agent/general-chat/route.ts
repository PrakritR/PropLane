import { NextResponse } from "next/server";
import { GENERAL_ASSISTANT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { applyChatAttachments, sanitizeChatMessages } from "@/lib/agent/chat-handler";
import { selectAgentRoute } from "@/lib/agent/model";
import { completeAgentModel } from "@/lib/agent/provider";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { formatAgentChatUserError } from "@/lib/agent/assistant-turn-error";
import { messagesNeedVisionModel, visionPinnedModel } from "@/lib/agent/assistant-vision-turn";

export const runtime = "nodejs";

/**
 * PUBLIC, UNAUTHENTICATED general-purpose website assistant.
 *
 * This is the "general AI" pinned bottom-right of every page. It is deliberately
 * DIFFERENT from the portal-scoped assistants:
 *
 *  - `/api/agent/chat` and `/api/agent/demo-chat` run the tool-calling agent loop
 *    grounded in a manager's portfolio (real or sandboxed demo) data.
 *  - THIS route answers broad questions about Axis the product and website. It
 *    has NO tools, NO database, and no way to read or change any account — it is
 *    a single guarded `messages.create` with a general system prompt.
 *
 * Being public and token-costing, it is IP rate-limited, and pasted user text is
 * treated as untrusted data by the system prompt (no actions are ever possible).
 */
export async function POST(req: Request) {
  const ip = clientIpFrom(req);
  if (!(await rateLimit(`general-chat:${ip}`, 12, 60_000)).ok) {
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

  let messages = sanitizeChatMessages(body.messages, { maxMessages: 16, maxChars: 4000 });
  if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
    return NextResponse.json({ error: "A user message is required." }, { status: 400 });
  }

  const attached = applyChatAttachments(messages, body);
  if (!attached.ok) return NextResponse.json({ error: attached.error }, { status: 400 });
  messages = attached.messages;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "The assistant isn't configured in this environment." },
      { status: 503 },
    );
  }

  try {
    const routing = messagesNeedVisionModel(messages)
      ? visionPinnedModel()
      : selectAgentRoute({ messages, actorKey: ip, availableTools: [] });
    const provider = "provider" in routing && routing.provider === "openrouter" ? "openrouter" : "anthropic";
    const route =
      "route" in routing && (routing.route === "fast_direct" || routing.route === "fast_lookup")
        ? routing.route
        : "anthropic";
    const fallbackModel =
      "fallbackModel" in routing && typeof routing.fallbackModel === "string" ? routing.fallbackModel : undefined;
    const response = await completeAgentModel({
      selection: {
        model: routing.model,
        tier: routing.tier,
        provider,
        route,
        ...(fallbackModel ? { fallbackModel } : {}),
      },
      system: GENERAL_ASSISTANT_SYSTEM_PROMPT,
      tools: [],
      messages,
    });
    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return NextResponse.json({ reply: reply || "I'm not sure how to answer that — try asking about PropLane's features, pricing, or the live demo." });
  } catch (e) {
    console.error("[agent/general-chat] failed:", e);
    const { message, httpStatus } = formatAgentChatUserError(e);
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
