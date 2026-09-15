/**
 * Shared helpers for the portal chat routes (manager / resident / vendor /
 * demo). Each route keeps its own context resolution, registry, and gating —
 * only the genuinely common message plumbing lives here.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildAttachmentUserMessage,
  parseChatDocuments,
  parseChatImages,
} from "@/lib/agent/images";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AppliedChatAttachments = {
  imageCount: number;
  documentCount: number;
};

/**
 * Optional image/PDF attachments apply to the LAST user message only; history
 * stays text-only so tool_use blocks never cross a turn boundary.
 */
export function applyChatAttachments(
  messages: Anthropic.MessageParam[],
  body: Record<string, unknown>,
):
  | ({ ok: true; messages: Anthropic.MessageParam[] } & AppliedChatAttachments)
  | { ok: false; error: string } {
  const images = parseChatImages(body.images);
  if (!images.ok) return { ok: false, error: images.error };
  const documents = parseChatDocuments(body.documents);
  if (!documents.ok) return { ok: false, error: documents.error };
  if (images.blocks.length === 0 && documents.blocks.length === 0) {
    return { ok: true, messages, imageCount: 0, documentCount: 0 };
  }
  if (images.blocks.length + documents.blocks.length > 4) {
    return { ok: false, error: "At most 4 attachments per message." };
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content !== "string") {
    return { ok: false, error: "A user message is required." };
  }
  const next = [...messages];
  next[next.length - 1] = buildAttachmentUserMessage(
    last.content,
    images.blocks,
    documents.blocks,
  );
  return {
    ok: true,
    messages: next,
    imageCount: images.blocks.length,
    documentCount: documents.blocks.length,
  };
}

/**
 * Sanitize client-supplied conversation history: user/assistant string
 * messages only, bounded count and per-message size. History is text-only by
 * design — tool_use blocks never cross a turn boundary, which is what makes
 * halting on a write proposal safe.
 */
export function sanitizeChatMessages(
  raw: unknown,
  opts: { maxMessages?: number; maxChars?: number } = {},
): Anthropic.MessageParam[] {
  const maxMessages = opts.maxMessages ?? 20;
  const maxChars = opts.maxChars ?? 8000;
  const rawMessages = Array.isArray(raw) ? (raw as ChatMessage[]) : [];
  return rawMessages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-maxMessages)
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxChars) }));
}

/** The last user message's text, for trace inputs and persistence. */
export function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && "text" in block) return String(block.text);
      }
    }
  }
  return "";
}
