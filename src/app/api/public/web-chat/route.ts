import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { featureSigningSecret } from "@/lib/feature-signing-secret.server";
import { clientIpFrom } from "@/lib/rate-limit";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createWebChatDeps, pollWebChat, sendWebChatMessage, sendWebChatPhoneCode, verifyWebChatPhone, type WebChatDeps } from "@/lib/web-chat/chat.server";
import { parseWebChatRequest } from "@/lib/web-chat/model";
import {
  newVisitorId,
  signVisitorCookie,
  verifyVisitorCookie,
  VISITOR_MAX_AGE_SEC,
  WEB_CHAT_COOKIE,
  WEB_CHAT_COOKIE_PATH,
} from "@/lib/web-chat/visitor-session";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

type Visitor = { visitorId: string; setCookie: string | null };

/** The visitor behind this request: the verified cookie's id, or (for a write) a fresh one. A bad cookie is simply no visitor. */
async function visitorOf(mint: boolean): Promise<Visitor | null> {
  const secret = featureSigningSecret("web-chat-visitor");
  const jar = await cookies();
  const check = verifyVisitorCookie(secret, jar.get(WEB_CHAT_COOKIE)?.value);
  if (check.ok) return { visitorId: check.visitorId, setCookie: check.needsRotation ? signVisitorCookie(secret, check.visitorId) : null };
  if (!mint) return null;
  const visitorId = newVisitorId();
  return { visitorId, setCookie: signVisitorCookie(secret, visitorId) };
}

function reply(body: Record<string, unknown>, init: { status?: number }, visitor: Visitor | null): NextResponse {
  const res = NextResponse.json(body, { status: init.status ?? 200, headers: NO_STORE });
  if (visitor?.setCookie) {
    res.cookies.set(WEB_CHAT_COOKIE, visitor.setCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: WEB_CHAT_COOKIE_PATH,
      maxAge: VISITOR_MAX_AGE_SEC,
    });
  }
  return res;
}

/**
 * Quick chat for an anonymous visitor on a listing page (captain, Nov 15): no account, no phone code to start. The visitor is a
 * signed httpOnly cookie id; the home, workspace and owner are re-derived from the database. Every message goes through the
 * prospect spine (`recordInbound`, source `web_chat`) into the manager's Communication inbox and is answered by the leasing
 * assistant exactly as a text would be (`runLeasingWebAgentTurn`).
 *
 *   POST { action: "send",         propertyId, roomId?, body, clientMessageId, website? }
 *   POST { action: "phone_code",   propertyId, phone }          text a code to continue by text
 *   POST { action: "phone_verify", propertyId, phone, otp }     a PROVEN phone merges the thread into that phone's
 *   GET  ?propertyId=&after=<turnId>                            the visitor's own new turns (the team's replies)
 */
export async function POST(req: Request) {
  const parsed = parseWebChatRequest(await req.json().catch(() => null));
  if (!parsed.ok) {
    if (parsed.silent) return reply({ ok: true }, {}, null);
    return reply({ error: parsed.error }, { status: 400 }, null);
  }
  const request = parsed.value;
  const visitor = await visitorOf(true);
  if (!visitor) return reply({ error: "Try again." }, { status: 503 }, null);
  const deps: WebChatDeps = createWebChatDeps(createSupabaseServiceRoleClient());
  const ip = clientIpFrom(req);

  if (request.action === "send") {
    const out = await sendWebChatMessage(deps, { visitorId: visitor.visitorId, ip, propertyId: request.propertyId, roomId: request.roomId, body: request.body, clientMessageId: request.clientMessageId });
    if (!out.ok) return reply({ error: out.error }, { status: out.status }, visitor);
    return reply({ ok: true, messageId: out.messageId, ...(out.phoneOffer ? { phoneOffer: out.phoneOffer } : {}), ...(out.duplicate ? { duplicate: true } : {}) }, {}, visitor);
  }
  if (request.action === "phone_code") {
    const out = await sendWebChatPhoneCode(deps, { visitorId: visitor.visitorId, ip, propertyId: request.propertyId, phone: request.phone });
    return out.ok ? reply({ ok: true }, {}, visitor) : reply({ error: out.error }, { status: out.status }, visitor);
  }
  const out = await verifyWebChatPhone(deps, { visitorId: visitor.visitorId, ip, propertyId: request.propertyId, phone: request.phone, otp: request.otp });
  return out.ok ? reply({ ok: true, merged: out.merged }, {}, visitor) : reply({ error: out.error, ...(out.needsNewCode ? { needsNewCode: true } : {}) }, { status: out.status }, visitor);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(propertyId)) return reply({ turns: [] }, {}, null);
  const after = url.searchParams.get("after")?.trim().slice(0, 200) || null;
  // A read never mints a visitor: no cookie, nothing to show.
  const visitor = await visitorOf(false);
  const signedIn = url.searchParams.get("init") === "1"
    ? await createRealIdentitySupabaseServerClient().then((c) => c.auth.getUser()).then((r) => Boolean(r.data.user)).catch(() => false)
    : undefined;
  if (!visitor) return reply({ turns: [], verified: false, ...(signedIn !== undefined ? { signedIn } : {}) }, {}, null);
  const out = await pollWebChat(createWebChatDeps(createSupabaseServiceRoleClient()), { visitorId: visitor.visitorId, propertyId, afterId: after });
  if (!out.ok) return reply({ error: out.error }, { status: out.status }, visitor);
  return reply({ turns: out.turns, verified: out.verified, ...(signedIn !== undefined ? { signedIn } : {}) }, {}, visitor);
}
