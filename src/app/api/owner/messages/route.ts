import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { loadOwnerConversations, OwnerMessageError, sendOwnerMessage } from "@/lib/property-owner/messages.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** GET /api/owner/messages — the owner's own conversation with each manager that has Messages on. 404 for the whole route while it is off. */
export async function GET() {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const conversations = await loadOwnerConversations(ctx.db, ctx.userId, ctx.grants);
    if (conversations.length === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ conversations }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load your messages." }, { status: 500 });
  }
}

/** POST /api/owner/messages { conversationId, body } — the recipient is resolved from the owner's own membership. */
export async function POST(req: Request) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  // Same shape as the portal's own send: a per-account and a per-IP bucket, so
  // one owner cannot flood their manager's inbox (or the delivery pipeline).
  if (
    !(await rateLimit(`owner-message:user:${ctx.userId}`, 30, 60_000)).ok ||
    !(await rateLimit(`owner-message:ip:${clientIpFrom(req)}`, 60, 60_000)).ok
  ) {
    return NextResponse.json({ error: "Too many messages - try again in a bit." }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { conversationId?: unknown; body?: unknown };
  try {
    await sendOwnerMessage(ctx.db, ctx.userId, ctx.grants, {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
      body: typeof body.body === "string" ? body.body : "",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof OwnerMessageError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Could not send your message." }, { status: 500 });
  }
}
