import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMedia: vi.fn(),
  indexed: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<{ path: string; contentType: string }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  files: [] as Array<Record<string, unknown>>,
  order: null as Record<string, unknown> | null,
  downloadOk: true,
}));

vi.mock("@/lib/inspections/attachment-intake.server", () => ({ fetchTwilioMessageMedia: mocks.fetchMedia }));
vi.mock("@/lib/sms-consent", () => ({ normalizeConsentPhone: (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") }));

const SID = "MM" + "a".repeat(32);
const URL0 = `https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/${SID}/Media/ME${"b".repeat(32)}`;

function db() {
  return {
    storage: {
      from: () => ({
        upload: async (path: string, _bytes: Buffer, opts: { contentType: string }) => { mocks.uploads.push({ path, contentType: opts.contentType }); return { error: null }; },
        download: async () => mocks.downloadOk ? { data: new Blob([new Uint8Array([1, 2, 3])]), error: null } : { data: null, error: { message: "x" } },
      }),
    },
    from: (table: string) => {
      let payload: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, in: () => q, like: () => q, or: () => q, gte: () => q, order: () => q, limit: () => q,
        is: () => q,
        update: (p: Record<string, unknown>) => { payload = p; mocks.updates.push({ table, payload: p }); return q; },
        upsert: async (row: Record<string, unknown>) => { mocks.upserts.push(row); return { error: null }; },
        maybeSingle: async () => ({ data: table === "portal_work_order_records" ? mocks.order : null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "sms_media_files" ? (payload ? null : mocks.files) : [], error: null }).then(resolve),
      };
      return q;
    },
  } as never;
}

import { attachVendorJobMedia, ingestInboundMedia, inboundMediaItems, linkSmsMediaToRecord, recentUnlinkedSmsMedia } from "@/lib/one-number/inbound-media.server";
import { loadSmsMediaForMessages, withSmsMedia } from "@/lib/one-number/sms-media-index.server";

describe("inbound MMS", () => {
  beforeEach(() => {
    mocks.fetchMedia.mockReset().mockResolvedValue({ bytes: Buffer.from([1, 2, 3, 4]), contentType: "image/jpeg" });
    mocks.upserts.length = 0; mocks.uploads.length = 0; mocks.updates.length = 0;
    mocks.files = []; mocks.order = null; mocks.downloadOk = true;
  });

  it("lists the media items of the verified webhook", () => {
    expect(inboundMediaItems({ NumMedia: "2", MediaUrl0: URL0, MediaContentType0: "image/jpeg", MediaUrl1: "http://insecure/x" })).toEqual([
      { index: 0, url: URL0, declaredType: "image/jpeg" },
    ]);
    expect(inboundMediaItems({ NumMedia: "0" })).toEqual([]);
    expect(inboundMediaItems({})).toEqual([]);
  });

  it("accepts a loopback http photo only while the e2e capture transport is on", () => {
    const loop = { NumMedia: "1", MediaUrl0: "http://127.0.0.1:3013/leak.png", MediaContentType0: "image/png" };
    const before = process.env.SMS_E2E_CAPTURE_FILE;
    try {
      delete process.env.SMS_E2E_CAPTURE_FILE;
      expect(inboundMediaItems(loop)).toEqual([]);
      process.env.SMS_E2E_CAPTURE_FILE = "/tmp/captured-sms.jsonl";
      expect(inboundMediaItems(loop)).toEqual([{ index: 0, url: "http://127.0.0.1:3013/leak.png", declaredType: "image/png" }]);
      expect(inboundMediaItems({ ...loop, MediaUrl0: "http://evil.example/leak.png" })).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.SMS_E2E_CAPTURE_FILE; else process.env.SMS_E2E_CAPTURE_FILE = before;
    }
  });

  it("downloads each item into the private bucket and indexes it with workspace and sender", async () => {
    const stored = await ingestInboundMedia(db(), {
      messageSid: SID, ownerUserId: "owner-1", workspaceId: "ws-1", senderPhone: "+12065551234",
      params: { NumMedia: "1", MediaUrl0: URL0, MediaContentType0: "image/jpeg" },
    });
    expect(mocks.fetchMedia).toHaveBeenCalledWith(URL0, SID, expect.any(Number));
    expect(mocks.uploads).toEqual([{ path: `manager/owner-1/${SID}/0.jpg`, contentType: "image/jpeg" }]);
    expect(mocks.upserts[0]).toMatchObject({
      message_sid: SID, media_index: 0, workspace_id: "ws-1", sender_phone_key: "2065551234",
      storage_path: `manager/owner-1/${SID}/0.jpg`, content_type: "image/jpeg", byte_size: 4,
    });
    expect(stored).toEqual([{ index: 0, path: `manager/owner-1/${SID}/0.jpg`, contentType: "image/jpeg", byteSize: 4 }]);
  });

  it("skips a type outside the allowlist and survives a failed download", async () => {
    mocks.fetchMedia.mockResolvedValueOnce({ bytes: Buffer.from([1]), contentType: "application/x-msdownload" });
    mocks.fetchMedia.mockRejectedValueOnce(new Error("Invalid message photo."));
    const stored = await ingestInboundMedia(db(), {
      messageSid: SID, ownerUserId: "owner-1", workspaceId: null, senderPhone: "+12065551234",
      params: { NumMedia: "2", MediaUrl0: URL0, MediaUrl1: URL0.replace("ME" + "b".repeat(32), "ME" + "c".repeat(32)) },
    });
    expect(stored).toEqual([]);
    expect(mocks.upserts).toEqual([]);
  });

  it("does nothing without media or a valid sender", async () => {
    await expect(ingestInboundMedia(db(), { messageSid: SID, ownerUserId: "o", workspaceId: null, senderPhone: "+12065551234", params: {} })).resolves.toEqual([]);
    await expect(ingestInboundMedia(db(), { messageSid: SID, ownerUserId: "o", workspaceId: null, senderPhone: "nope", params: { NumMedia: "1", MediaUrl0: URL0 } })).resolves.toEqual([]);
    expect(mocks.fetchMedia).not.toHaveBeenCalled();
  });

  it("links a message's files to a record without overwriting an existing link", async () => {
    await linkSmsMediaToRecord(db(), { messageSid: SID, linkedType: "work_order", linkedId: "REQ-1" });
    expect(mocks.updates[0]).toEqual({ table: "sms_media_files", payload: { linked_type: "work_order", linked_id: "REQ-1" } });
  });

  it("returns a resident's recent unlinked files", async () => {
    mocks.files = [{ id: "f1", content_type: "image/jpeg", storage_path: "manager/o/x/0.jpg" }];
    await expect(recentUnlinkedSmsMedia(db(), { ownerUserId: "o", senderPhone: "+12065551234" })).resolves.toHaveLength(1);
    await expect(recentUnlinkedSmsMedia(db(), { ownerUserId: "o", senderPhone: "bad" })).resolves.toEqual([]);
  });

  it("vendor photo on an open job: linked to the job and added to its completion photos", async () => {
    mocks.files = [{ id: "f1", content_type: "image/jpeg", storage_path: "manager/o/x/0.jpg" }];
    mocks.order = { id: "WO-9", row_data: { title: "Leak", completionPhotoDataUrls: ["data:image/png;base64,OLD"] } };
    await expect(attachVendorJobMedia(db(), { ownerUserId: "o", workOrderId: "WO-9", messageSid: SID })).resolves.toEqual({ linked: 1 });
    const orderUpdate = mocks.updates.find((u) => u.table === "portal_work_order_records");
    expect((orderUpdate?.payload.row_data as { completionPhotoDataUrls: string[] }).completionPhotoDataUrls).toEqual([
      "data:image/png;base64,OLD", "data:image/jpeg;base64,AQID",
    ]);
    expect(mocks.updates.find((u) => u.table === "sms_media_files")?.payload).toEqual({ linked_type: "vendor_job", linked_id: "WO-9" });
  });

  it("a vendor photo for a job that is not this owner's links nothing", async () => {
    mocks.files = [{ id: "f1", content_type: "image/jpeg", storage_path: "manager/o/x/0.jpg" }];
    mocks.order = null;
    await expect(attachVendorJobMedia(db(), { ownerUserId: "o", workOrderId: "WO-X", messageSid: SID })).resolves.toEqual({ linked: 0 });
    await expect(attachVendorJobMedia(db(), { ownerUserId: "o", workOrderId: null, messageSid: SID })).resolves.toEqual({ linked: 0 });
    expect(mocks.updates).toEqual([]);
  });
});

describe("media on Communication bubbles", () => {
  it("only MMS sids are looked up and each gets its in-app serve url", async () => {
    mocks.files = [{ message_sid: SID, media_index: 0, storage_path: "manager/o/x/0.jpg", content_type: "image/jpeg" }];
    const messages = await withSmsMedia(db(), [
      { messageSid: SID, body: "" },
      { messageSid: "SM" + "d".repeat(32), body: "plain" },
      { messageSid: null, body: "none" },
    ]);
    expect(messages[0].media).toEqual([{ path: "manager/o/x/0.jpg", contentType: "image/jpeg", url: `/api/sms-media?path=${encodeURIComponent("manager/o/x/0.jpg")}` }]);
    expect(messages[1]).not.toHaveProperty("media");
    expect((await loadSmsMediaForMessages(db(), ["SM" + "d".repeat(32), null])).size).toBe(0);
  });
});
