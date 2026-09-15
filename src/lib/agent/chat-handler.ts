/**
 * Shared helpers for the portal chat routes (manager / resident / vendor /
 * demo). Each route keeps its own context resolution, registry, and gating —
 * only the genuinely common message plumbing lives here.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAttachmentUserMessage,
  parseChatDocuments,
  parseChatImages,
  parseChatImportIds,
} from "@/lib/agent/images";
import { loadPortfolioImport, summaryFor } from "@/lib/portfolio-import/store.server";

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

export type AppliedImportAttachments = {
  importCount: number;
};

/**
 * Portfolio-import draft ids the manager's rent-roll attachment created
 * (`assistant-chat-attachments.client.ts`). Manager-only: the caller passes
 * `ctx.db`/`ctx.landlordId` from `resolveAgentContext`, never model input.
 * Every id is re-verified to belong to this landlord before it can reach the
 * model — an id that is not owned (or has no draft) is silently dropped
 * rather than failing the whole turn. Owned drafts are appended as a plain
 * text note on the LAST user message (never a content block the model could
 * mistake for a tool result), so `get_portfolio_import` /
 * `commit_portfolio_import` / `invite_imported_residents` have an id to act
 * on without asking the manager to re-type the file's rows.
 */
export async function applyImportAttachments(
  ctx: { db: SupabaseClient; landlordId: string },
  messages: Anthropic.MessageParam[],
  body: Record<string, unknown>,
):
  | Promise<({ ok: true; messages: Anthropic.MessageParam[] } & AppliedImportAttachments) | { ok: false; error: string }> {
  const parsed = parseChatImportIds(body.importIds);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.ids.length === 0) return { ok: true, messages, importCount: 0 };

  const owned: {
    id: string;
    fileName: string;
    propertyCount: number;
    unitCount: number;
    residentCount: number;
    blockingIssueCount: number;
  }[] = [];
  for (const id of parsed.ids) {
    const row = await loadPortfolioImport(ctx.db, ctx.landlordId, id).catch(() => null);
    if (!row || !row.draft) continue;
    const summary = summaryFor(row);
    if (!summary) continue;
    owned.push({
      id,
      fileName: summary.fileName,
      propertyCount: summary.propertyCount,
      unitCount: summary.unitCount,
      residentCount: summary.residentCount,
      blockingIssueCount: summary.blockingIssueCount,
    });
  }
  if (owned.length === 0) return { ok: true, messages, importCount: 0 };

  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return { ok: false, error: "A user message is required." };
  }

  const note = owned
    .map(
      (o) =>
        `Manager attached a portfolio import draft (importId ${o.id}): ${o.fileName} — ${o.propertyCount} properties, ${o.unitCount} units, ${o.residentCount} residents, ${o.blockingIssueCount} blocking issues. Use get_portfolio_import / commit_portfolio_import / invite_imported_residents with this id.`,
    )
    .join("\n");

  const nextLast: Anthropic.MessageParam =
    typeof last.content === "string"
      ? { role: "user", content: `${last.content}\n\n${note}` }
      : { role: "user", content: [...last.content, { type: "text", text: note }] };

  const next = [...messages];
  next[next.length - 1] = nextLast;
  return { ok: true, messages: next, importCount: owned.length };
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
