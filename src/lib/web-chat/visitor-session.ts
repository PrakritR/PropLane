import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The anonymous web-chat visitor (captain, Nov 15). The visitor is a random id carried in a signed httpOnly cookie and
 * NOTHING else: no name, email or phone identifies them. The cookie is `v1.<id>.<issuedAtSec>.<hmac>`; a tampered, malformed,
 * expired or foreign-secret cookie reads as "no visitor" (the route then mints a fresh one). The id is stable across
 * rotation, so the conversation survives; only the signature window moves (`needsRotation`, after a week, re-signed on the next
 * request). Pure: the secret and the clock are arguments, so tests need no environment.
 */
export const WEB_CHAT_COOKIE = "pl_wc";
export const WEB_CHAT_COOKIE_PATH = "/api/public/web-chat";
/** A visitor id is forgotten after 90 days of silence (the cookie's own lifetime). */
export const VISITOR_MAX_AGE_SEC = 90 * 24 * 60 * 60;
/** A cookie older than this is re-signed (same id, fresh issue time) on its next use. */
export const VISITOR_ROTATE_AFTER_SEC = 7 * 24 * 60 * 60;

const ID_RE = /^[0-9a-f]{32}$/;

export type VisitorCookieCheck =
  | { ok: true; visitorId: string; needsRotation: boolean }
  | { ok: false };

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function newVisitorId(): string {
  return randomBytes(16).toString("hex");
}

export function signVisitorCookie(secret: string, visitorId: string, nowMs: number = Date.now()): string {
  const payload = `v1.${visitorId}.${Math.floor(nowMs / 1000)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyVisitorCookie(secret: string, raw: string | null | undefined, nowMs: number = Date.now()): VisitorCookieCheck {
  const value = (raw ?? "").trim();
  if (!value || value.length > 200) return { ok: false };
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { ok: false };
  const [, visitorId, issued, mac] = parts;
  if (!ID_RE.test(visitorId) || !/^\d{9,11}$/.test(issued)) return { ok: false };
  const expected = sign(secret, `v1.${visitorId}.${issued}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  const ageSec = Math.floor(nowMs / 1000) - Number(issued);
  if (ageSec < -300 || ageSec > VISITOR_MAX_AGE_SEC) return { ok: false };
  return { ok: true, visitorId, needsRotation: ageSec > VISITOR_ROTATE_AFTER_SEC };
}

/** The prospect-spine handle for a visitor. Stable, never derived from anything the visitor typed. */
export function visitorHandle(visitorId: string): string {
  return `web_${visitorId}`;
}

/** Read one cookie out of a raw `Cookie` header. */
export function cookieFromHeader(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}
