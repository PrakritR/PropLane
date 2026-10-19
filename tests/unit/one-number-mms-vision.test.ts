// A texted photo is read by the model: the stored MMS file becomes an image block on THIS turn's user
// message only, history stays text, and only this owner's files for this message are ever shown.
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));

import { attachImagesToLastUserMessage } from "@/lib/agent/images";
import { inboundImageBlocks } from "@/lib/one-number/inbound-media.server";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function world(extra: Array<Record<string, unknown>> = []) {
  const db = createMemoryDb({
    sms_media_files: [
      { id: "f1", message_sid: "SM1", media_index: 0, storage_path: "manager/owner-1/SM1/0.png", content_type: "image/png" },
      { id: "f2", message_sid: "SM1", media_index: 1, storage_path: "manager/owner-1/SM1/1.pdf", content_type: "application/pdf" },
      { id: "f3", message_sid: "SM1", media_index: 2, storage_path: "manager/owner-2/SM1/2.png", content_type: "image/png" },
      { id: "f4", message_sid: "SM2", media_index: 0, storage_path: "manager/owner-1/SM2/0.png", content_type: "image/png" },
      ...extra,
    ],
  });
  const downloads: string[] = [];
  (db as unknown as { storage: unknown }).storage = {
    from: () => ({
      download: async (path: string) => {
        downloads.push(path);
        return path.includes("big") ? { data: new Blob([Buffer.alloc(4_000_000)]), error: null } : { data: new Blob([PNG], { type: "image/png" }), error: null };
      },
    }),
  };
  return { db, downloads };
}

describe("inboundImageBlocks", () => {
  it("returns this message's own images from this owner's path, as base64 blocks", async () => {
    const { db, downloads } = world();
    const blocks = await inboundImageBlocks(db as never, { ownerUserId: "owner-1", messageSid: "SM1" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    // The PDF, another owner's file and another text's file were never even downloaded.
    expect(downloads).toEqual(["manager/owner-1/SM1/0.png"]);
  });

  it("skips an image over the model's size limit and anything unreadable", async () => {
    const { db } = world([{ id: "f5", message_sid: "SM3", media_index: 0, storage_path: "manager/owner-1/SM3/big.png", content_type: "image/png" }]);
    expect(await inboundImageBlocks(db as never, { ownerUserId: "owner-1", messageSid: "SM3" })).toEqual([]);
    expect(await inboundImageBlocks(db as never, { ownerUserId: "owner-1", messageSid: "SM-none" })).toEqual([]);
  });
});

describe("attachImagesToLastUserMessage", () => {
  const image: Anthropic.ImageBlockParam = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "my ceiling is leaking" },
  ];

  it("puts the photos on the last user message only and keeps the text", () => {
    const out = attachImagesToLastUserMessage(history, [image]);
    expect(out.attached).toBe(true);
    expect(out.messages.slice(0, 2)).toEqual(history.slice(0, 2));
    expect(out.messages[2]).toEqual({ role: "user", content: [image, { type: "text", text: "my ceiling is leaking" }] });
  });

  it("changes nothing without photos or when the last message is not a plain user text", () => {
    expect(attachImagesToLastUserMessage(history, [])).toEqual({ messages: history, attached: false });
    const endsWithAssistant = history.slice(0, 2);
    expect(attachImagesToLastUserMessage(endsWithAssistant, [image])).toEqual({ messages: endsWithAssistant, attached: false });
  });
});
