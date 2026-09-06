import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INBOX_ATTACHMENTS_BUCKET, isInboxAttachmentPath } from "@/lib/inbox-attachments.server";
import { InspectionError } from "./model";
import type { InspectionActor } from "./server";

const MAX_BYTES = 5 * 1024 * 1024;
export async function storeInspectionIntake(db: SupabaseClient, userId: string, bytes: Buffer, ownerId?: string): Promise<string> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new InspectionError("Choose a photo smaller than 5 MB.");
  let image: Buffer;
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png", "webp", "gif"].includes(metadata.format ?? "")) throw new Error("unsupported");
    image = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch { throw new InspectionError("Choose a valid JPEG, PNG or WebP photo."); }
  const digest = createHash("sha256").update(image).digest("hex");
  const path = `${userId}/inspection-chat/${ownerId ?? "portal"}/${digest}.jpg`;
  const { error } = await db.storage.from(INBOX_ATTACHMENTS_BUCKET).upload(path, image, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new InspectionError("Could not save the photo for your inspection.", 500);
  return path;
}

export function ownedInspectionSource(actor: InspectionActor, path: string): boolean {
  if (!isInboxAttachmentPath(path) || !path.startsWith(`${actor.context.userId}/`) || /[\\?#%]/.test(path)) return false;
  if (actor.role === "resident" && actor.context.activeManagerId) {
    if (path.startsWith(`${actor.context.userId}/inspection-chat/`) && !path.startsWith(`${actor.context.userId}/inspection-chat/portal/`) && !path.startsWith(`${actor.context.userId}/inspection-chat/${actor.context.activeManagerId}/`)) return false;
  }
  return /\.(jpg|jpeg|png|webp)$/i.test(path);
}

export async function resolveInspectionSource(actor: InspectionActor, sourceRef: string): Promise<File> {
  if (!ownedInspectionSource(actor, sourceRef)) throw new InspectionError("Choose one of your own uploaded photos.", 404);
  const { data, error } = await actor.context.db.storage.from(INBOX_ATTACHMENTS_BUCKET).download(sourceRef);
  if (error || !data) throw new InspectionError("Photo not found. Attach it again.", 404);
  if (data.size > MAX_BYTES) throw new InspectionError("Choose a photo smaller than 5 MB.");
  return new File([data], "inspection-photo.jpg", { type: data.type });
}

export async function attachPrivateInspectionSources(db: SupabaseClient, userId: string, messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  const last = messages.at(-1);
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return messages;
  const refs: string[] = [];
  for (const block of last.content) {
    if (block.type === "image" && block.source.type === "base64") refs.push(await storeInspectionIntake(db, userId, Buffer.from(block.source.data, "base64")));
  }
  if (!refs.length) return messages;
  // Prepend to the first text block so archive/lastUserText preserve the references.
  const note = `Private photo source references (not filed yet):\n${refs.join("\n")}\nUse file_inspection_photo only after resolving the assigned room, report and section. Ask when unclear. Never infer condition from an image.\n\n`;
  const content = [...last.content];
  const index = content.findIndex(b => b.type === "text");
  if (index >= 0 && content[index].type === "text") content[index] = { type: "text", text: note + content[index].text };
  else content.unshift({ type: "text", text: note });
  return [...messages.slice(0, -1), { ...last, content }];
}

/** The verified Twilio webhook is the only source of these URLs and identity. */
export async function intakeResidentSmsPhotos(db: SupabaseClient, input: { userId: string; ownerId: string; messageSid: string; params: Record<string, string> }): Promise<string[]> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim(), token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const count = Math.min(Number(input.params.NumMedia) || 0, 4);
  if (!count) return [];
  if (!sid || !token || !/^(SM|MM)[a-fA-F0-9]{32}$/.test(input.messageSid)) throw new InspectionError("Photo intake is unavailable.", 503);
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const url = new URL(input.params[`MediaUrl${i}`]);
    const expected = `/2010-04-01/Accounts/${sid}/Messages/${input.messageSid}/Media/`;
    if (url.origin !== "https://api.twilio.com" || !url.pathname.startsWith(expected) || !/^ME[a-fA-F0-9]{32}$/.test(url.pathname.slice(expected.length)) || url.search) throw new InspectionError("Invalid message photo.");
    let response = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    // Twilio redirects media to its signed CDN URL. Never forward account credentials.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = new URL(response.headers.get("location") || "", url);
      if (location.origin !== "https://mms.twiliocdn.com" || location.username || location.password) throw new InspectionError("Invalid message photo redirect.");
      await response.body?.cancel();
      response = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    }
    if (!response.ok || !response.body) throw new InspectionError("Could not receive the photo. Please retry.", 503);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) throw new InspectionError("Photo must be smaller than 5 MB."); chunks.push(value); } }
    finally { await reader.cancel(); }
    refs.push(await storeInspectionIntake(db, input.userId, Buffer.concat(chunks), input.ownerId));
  }
  return refs;
}
