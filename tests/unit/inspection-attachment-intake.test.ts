import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InspectionActor } from "@/lib/inspections/server";
import { attachPrivateInspectionSources, intakeResidentSmsPhotos, resolveInspectionSource, storeInspectionIntake } from "@/lib/inspections/attachment-intake.server";
import { lastUserText } from "@/lib/agent/chat-handler";

function fixture() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob(["photo"], { type: "image/jpeg" }), error: null });
  const from = vi.fn(() => ({ upload, download }));
  const db = { storage: { from } } as unknown as SupabaseClient;
  const actor = (userId = "resident", activeManagerId?: string) => ({ role: "resident", context: { userId, activeManagerId, db } }) as InspectionActor;
  return { db, upload, download, from, actor };
}
const gif = () => sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).gif().toBuffer();
const accountSid = `AC${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;
const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/ME${"3".repeat(32)}`;
const smsInput = { userId: "resident", ownerId: "owner", messageSid, params: { NumMedia: "1", MediaUrl0: mediaUrl } };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("private inspection attachment intake", () => {
  it("keeps accepted GIF chat attachments usable and stores an actual private JPEG", async () => {
    const { db, upload, from } = fixture();
    const path = await storeInspectionIntake(db, "resident", await gif());
    expect(path).toMatch(/^resident\/inspection-chat\/portal\/[a-f0-9]{64}\.jpg$/);
    expect(from).toHaveBeenCalledWith("portal-inbox-attachments");
    expect((await sharp(upload.mock.calls[0][1]).metadata()).format).toBe("jpeg");
    expect(upload.mock.calls[0][2]).toMatchObject({ upsert: false, contentType: "image/jpeg" });
  });

  it("retains source references in the text used by archive and clarification turns", async () => {
    const { db, upload } = fixture();
    const messages = await attachPrivateInspectionSources(db, "resident", [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/gif", data: (await gif()).toString("base64") } },
      { type: "text", text: "Please file the mark beside my door." },
    ] }]);
    expect(lastUserText(messages)).toContain(upload.mock.calls[0][0]);
    expect(lastUserText(messages)).toContain("Please file the mark beside my door.");
  });

  it.each([
    "other-resident/inspection-chat/portal/photo.jpg",
    "resident/../other-resident/photo.jpg",
    "resident/inspection-chat/portal/%2e%2e/photo.jpg",
    "https://example.test/photo.jpg",
    "resident/inspection-chat/other-manager/photo.jpg",
  ])("rejects an unowned or malformed source before any storage read: %s", async source => {
    const { actor, download } = fixture();
    await expect(resolveInspectionSource(actor("resident", "owner"), source)).rejects.toMatchObject({ status: 404 });
    expect(download).not.toHaveBeenCalled();
  });

  it("allows the same resident's portal uploads and current-owner SMS uploads", async () => {
    const { actor, download } = fixture();
    for (const path of ["resident/inspection-chat/portal/photo.jpg", "resident/inspection-chat/owner/photo.jpg", "resident/1700000000-upload/original.png"]) {
      expect(await resolveInspectionSource(actor("resident", "owner"), path)).toBeInstanceOf(File);
    }
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("follows Twilio's signed CDN redirect without leaking account credentials", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid); vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://mms.twiliocdn.com/media/photo?token=test" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(await gif()), { headers: { "Content-Type": "image/gif" } }));
    vi.stubGlobal("fetch", fetcher);
    const { db } = fixture();
    const refs = await intakeResidentSmsPhotos(db, smsInput);
    expect(refs[0]).toMatch(/^resident\/inspection-chat\/owner\//);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { Authorization: expect.stringMatching(/^Basic /) } });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: "error" });
    expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
  });

  it.each(["https://mms.twiliocdn.com.evil.test/photo", "http://mms.twiliocdn.com/photo", "https://user:password@mms.twiliocdn.com/photo"])("rejects an unsafe media redirect: %s", async location => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid); vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetcher);
    const { db, upload } = fixture();
    await expect(intakeResidentSmsPhotos(db, smsInput)).rejects.toThrow(/redirect/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects another message's media URL before sending Twilio credentials", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid); vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(intakeResidentSmsPhotos(fixture().db, { ...smsInput, params: { NumMedia: "1", MediaUrl0: mediaUrl.replace(messageSid, `SM${"4".repeat(32)}`) } })).rejects.toThrow(/Invalid message/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
