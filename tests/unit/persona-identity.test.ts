import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonaInquiry, personaEnabled, resumePersonaInquiry, verifyPersonaSignature } from "@/lib/resident-identity/persona.server";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

describe("Persona identity adapter", () => {
  it("defaults off and requires every credential", () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona";
    process.env.PERSONA_API_KEY = "key";
    process.env.PERSONA_TEMPLATE_ID = "template";
    delete process.env.PERSONA_WEBHOOK_SECRET;
    expect(personaEnabled()).toBe(false);
    process.env.PERSONA_WEBHOOK_SECRET = "secret";
    expect(personaEnabled()).toBe(true);
  });
  it("checks rotated signatures, body integrity and timestamp", () => {
    const body = '{"data":{}}';
    const timestamp = "1700000000";
    const signature = createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=${"0".repeat(64)} t=${timestamp},v1=${signature}`;
    expect(verifyPersonaSignature(body, header, "secret", 1700000000000)).toBe(true);
    expect(verifyPersonaSignature(body + " ", header, "secret", 1700000000000)).toBe(false);
    expect(verifyPersonaSignature(body, header, "secret", 1700000400000)).toBe(false);
    expect(verifyPersonaSignature(body, header, "", 1700000000000)).toBe(false);
  });
  it("pins version and claim key and builds a unique hosted resume link", async () => {
    process.env.PERSONA_API_KEY = "key";
    process.env.PERSONA_TEMPLATE_ID = "itmpl_test";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "inq_test", attributes: { "reference-id": "resident" } }, meta: { "session-token": "secret-token" } }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createPersonaInquiry("resident", "claim")).toBe("inq_test");
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "Persona-Version": "2026-09-29", "Idempotency-Key": "claim" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).data.attributes["reference-id"]).toBe("resident");
    const url = new URL(await resumePersonaInquiry("inq_test", "resident"));
    expect(url.host).toBe("inquiry.withpersona.com");
    expect(url.searchParams.get("inquiry-id")).toBe("inq_test");
    expect(url.searchParams.get("session-token")).toBe("secret-token");
  });
  it("refuses a provider response for another resident", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "inq_test", attributes: { "reference-id": "other" } } }) }));
    await expect(createPersonaInquiry("resident", "claim")).rejects.toThrow("invalid");
  });
});
