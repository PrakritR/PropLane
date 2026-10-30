import { createHmac, timingSafeEqual } from "node:crypto";

export const PERSONA_VERSION = "2026-09-29";
export function personaEnabled(): boolean {
  return process.env.RESIDENT_IDENTITY_ENABLED === "true" && Boolean(process.env.PERSONA_API_KEY?.trim() && process.env.PERSONA_TEMPLATE_ID?.trim() && process.env.PERSONA_WEBHOOK_SECRET?.trim());
}

export function verifyPersonaSignature(body: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!secret || !header) return false;
  return header.trim().split(/\s+/).some((set) => {
    const parts = set.split(",");
    const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
    const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
    return signatures.some((signature) => {
      if (!/^[a-f\d]{64}$/i.test(signature)) return false;
      return timingSafeEqual(Buffer.from(signature, "hex"), expected);
    });
  });
}

type PersonaResponse = { data?: { id?: string; attributes?: { "reference-id"?: string } }; meta?: { "session-token"?: string } };
async function personaRequest(path: string, body?: object, idempotencyKey?: string, method: "GET" | "POST" = "POST"): Promise<PersonaResponse> {
  const response = await fetch(`https://api.withpersona.com/api/v1${path}`, {
    method, cache: "no-store", headers: {
      Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
      "Persona-Version": PERSONA_VERSION, "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error("Persona request unavailable");
  return await response.json() as PersonaResponse;
}
/** Approval must agree with the current provider state and subject. */
export async function isPersonaInquiryApproved(id: string, userId: string): Promise<boolean> {
  const result = await personaRequest(`/inquiries/${encodeURIComponent(id)}`, undefined, undefined, "GET");
  return result.data?.id === id && result.data.attributes?.["reference-id"] === userId &&
    (result.data.attributes as { status?: string }).status === "approved";
}
export async function createPersonaInquiry(userId: string, claimKey: string) {
  const result = await personaRequest("/inquiries", { data: { attributes: {
    "inquiry-template-id": process.env.PERSONA_TEMPLATE_ID, "reference-id": userId,
  } } }, claimKey);
  const id = result.data?.id;
  if (!id?.startsWith("inq_") || result.data?.attributes?.["reference-id"] !== userId) throw new Error("Persona response invalid");
  return id;
}
export async function resumePersonaInquiry(id: string, userId: string) {
  const result = await personaRequest(`/inquiries/${encodeURIComponent(id)}/resume`);
  const token = result.meta?.["session-token"];
  if (result.data?.id !== id || result.data?.attributes?.["reference-id"] !== userId || !token) throw new Error("Persona response invalid");
  const url = new URL("https://inquiry.withpersona.com/verify");
  url.searchParams.set("inquiry-id", id);
  url.searchParams.set("session-token", token);
  return url.toString();
}
