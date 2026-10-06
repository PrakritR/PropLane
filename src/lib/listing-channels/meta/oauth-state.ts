import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed `state` for Meta's OAuth dialog. HMAC-SHA256 with the Meta app secret, bound to the manager,
 * the workspace and the page to return to, and good for 15 minutes. The callback also checks the
 * signed-in session is the same user, so a state minted for one manager can never connect another's
 * workspace.
 */
export const META_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export type MetaOAuthState = {
  userId: string;
  workspaceId: string;
  returnPath: string;
};

type Payload = { uid: string; wid: string; rp: string; t: number; p: "meta" };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signMetaOAuthState(state: MetaOAuthState, secret: string, now = Date.now()): string {
  const payload = JSON.stringify({ uid: state.userId, wid: state.workspaceId, rp: state.returnPath, t: now, p: "meta" } satisfies Payload);
  return Buffer.from(`${payload}|${sign(payload, secret)}`).toString("base64url");
}

export function verifyMetaOAuthState(raw: string | null | undefined, secret: string, now = Date.now()): MetaOAuthState | null {
  if (!raw || !secret) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep < 0) return null;
    const payload = decoded.slice(0, sep);
    const given = Buffer.from(decoded.slice(sep + 1));
    const expected = Buffer.from(sign(payload, secret));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = JSON.parse(payload) as Partial<Payload>;
    if (parsed.p !== "meta" || typeof parsed.uid !== "string" || typeof parsed.wid !== "string") return null;
    if (typeof parsed.t !== "number" || now - parsed.t > META_OAUTH_STATE_TTL_MS || parsed.t - now > 60_000) return null;
    const returnPath = typeof parsed.rp === "string" && parsed.rp.startsWith("/") && !parsed.rp.startsWith("//") ? parsed.rp : "/portal/profile";
    return { userId: parsed.uid, workspaceId: parsed.wid, returnPath };
  } catch {
    return null;
  }
}
