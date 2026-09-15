/**
 * Image and document attachments for assistant chat. The client downscales and
 * base64s files; this module validates them and builds Anthropic content
 * blocks. Attachments ride on the LAST user message only — history stays
 * text-only, which keeps the loop's halt-on-write-proposal safe and bounds
 * request size.
 */
import type Anthropic from "@anthropic-ai/sdk";

const ALLOWED_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ALLOWED_DOCUMENT_MEDIA_TYPES = new Set(["application/pdf"]);

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_DOCUMENTS = 2;
export const MAX_CHAT_ATTACHMENTS = 4;
// Vercel's request body cap is 4.5MB; base64 inflates ~4/3, so cap the encoded
// payload total well under it.
export const MAX_TOTAL_ATTACHMENT_BASE64_CHARS = 4 * 1024 * 1024;
/** @deprecated use MAX_TOTAL_ATTACHMENT_BASE64_CHARS */
export const MAX_TOTAL_IMAGE_BASE64_CHARS = MAX_TOTAL_ATTACHMENT_BASE64_CHARS;

export type ChatImageInput = { mediaType: string; dataBase64: string };
export type ChatDocumentInput = { mediaType: string; dataBase64: string; fileName?: string };

export type ParsedChatImages =
  | { ok: true; blocks: Anthropic.ImageBlockParam[] }
  | { ok: false; error: string };

export type ParsedChatDocuments =
  | { ok: true; blocks: Anthropic.DocumentBlockParam[] }
  | { ok: false; error: string };

function normalizeBase64Payload(data: string): string {
  return data.replace(/\s/g, "");
}

function validateBase64Payload(
  data: string,
  totalChars: { value: number },
): string | null {
  const normalized = normalizeBase64Payload(data);
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return "Invalid attachment data.";
  totalChars.value += normalized.length;
  if (totalChars.value > MAX_TOTAL_ATTACHMENT_BASE64_CHARS) {
    return "Attachments are too large — try fewer or smaller files.";
  }
  return null;
}

export function parseChatImages(raw: unknown): ParsedChatImages {
  if (raw == null) return { ok: true, blocks: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "images must be an array." };
  if (raw.length === 0) return { ok: true, blocks: [] };
  if (raw.length > MAX_CHAT_IMAGES) {
    return { ok: false, error: `At most ${MAX_CHAT_IMAGES} images per message.` };
  }

  const blocks: Anthropic.ImageBlockParam[] = [];
  const totalChars = { value: 0 };
  for (const item of raw as ChatImageInput[]) {
    const mediaType = String(item?.mediaType ?? "").trim().toLowerCase();
    const data = normalizeBase64Payload(String(item?.dataBase64 ?? "").trim());
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, error: "Unsupported image type — use JPEG, PNG, WebP, or GIF." };
    }
    const err = validateBase64Payload(data, totalChars);
    if (err) return { ok: false, error: err };
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data,
      },
    });
  }
  return { ok: true, blocks };
}

export function parseChatDocuments(raw: unknown): ParsedChatDocuments {
  if (raw == null) return { ok: true, blocks: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "documents must be an array." };
  if (raw.length === 0) return { ok: true, blocks: [] };
  if (raw.length > MAX_CHAT_DOCUMENTS) {
    return { ok: false, error: `At most ${MAX_CHAT_DOCUMENTS} PDFs per message.` };
  }

  const blocks: Anthropic.DocumentBlockParam[] = [];
  const totalChars = { value: 0 };
  for (const item of raw as ChatDocumentInput[]) {
    const mediaType = String(item?.mediaType ?? "").trim().toLowerCase();
    const data = normalizeBase64Payload(String(item?.dataBase64 ?? "").trim());
    if (!ALLOWED_DOCUMENT_MEDIA_TYPES.has(mediaType)) {
      return { ok: false, error: "Unsupported document type — use PDF." };
    }
    const err = validateBase64Payload(data, totalChars);
    if (err) return { ok: false, error: err };
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data,
      },
    });
  }
  return { ok: true, blocks };
}

/** Compose the final user message: attachments first, then the text. */
export function buildAttachmentUserMessage(
  text: string,
  imageBlocks: Anthropic.ImageBlockParam[],
  documentBlocks: Anthropic.DocumentBlockParam[] = [],
): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [...documentBlocks, ...imageBlocks];
  const fallback =
    documentBlocks.length > 0 && imageBlocks.length > 0
      ? "(See attached files.)"
      : documentBlocks.length > 0
        ? "(See attached PDF.)"
        : "(See attached images.)";
  content.push({ type: "text", text: text || fallback });
  return { role: "user", content };
}

/** @deprecated use buildAttachmentUserMessage */
export function buildImageUserMessage(
  text: string,
  blocks: Anthropic.ImageBlockParam[],
): Anthropic.MessageParam {
  return buildAttachmentUserMessage(text, blocks);
}
