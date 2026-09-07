/**
 * One webhook subscription: delete, rotate its signing secret, or send a test
 * event through the real delivery pipeline.
 *
 * Every helper here scopes on `manager_user_id` as well as the row id, so
 * another manager's subscription id is a 404 rather than an action.
 */
import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { rateLimit } from "@/lib/rate-limit";
import { sendTestWebhookEvent } from "@/lib/webhooks/deliver.server";
import { deleteWebhookSubscription, rotateWebhookSecret } from "@/lib/webhooks/subscriptions.server";

export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;
  const deleted = await deleteWebhookSubscription(actor.db, { managerUserId: actor.userId, id });
  if (!deleted) return NextResponse.json({ error: "Webhook not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { id } = await ctx.params;

  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  if (body.action === "rotate") {
    const rotated = await rotateWebhookSecret(actor.db, { managerUserId: actor.userId, id });
    if (!rotated) return NextResponse.json({ error: "Webhook not found." }, { status: 404 });
    // The new secret is shown once; the previous one stops signing immediately.
    return NextResponse.json({ webhook: rotated.subscription, secret: rotated.secret });
  }

  if (body.action === "test") {
    if (!(await rateLimit(`webhook-test:${actor.userId}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }
    const outcome = await sendTestWebhookEvent(actor.db, { managerUserId: actor.userId, subscriptionId: id });
    return NextResponse.json({ ok: outcome.ok, status: outcome.status, error: outcome.error });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
