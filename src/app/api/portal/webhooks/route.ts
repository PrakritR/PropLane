/**
 * Outbound webhook management for the signed-in manager.
 *
 * Authorized exactly like `/api/manager/api-keys`: `resolveAgentContext`, which
 * rejects non-managers, then a service-role client because
 * `webhook_subscriptions` is RLS-default-deny. Every query is pinned to
 * `ctx.userId`; nothing here ever takes an owner from the request body.
 *
 * The signing secret exists in a response body exactly twice — the POST that
 * creates a webhook and the rotate call — and never in GET.
 */
import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";
import { rateLimit } from "@/lib/rate-limit";
import { WEBHOOK_EVENT_TYPES, normalizeWebhookEvents } from "@/lib/webhooks/events";
import { createWebhookSubscription, listWebhookSubscriptions } from "@/lib/webhooks/subscriptions.server";

export const runtime = "nodejs";

/** A manager with more endpoints than this is not curating them. */
const MAX_SUBSCRIPTIONS = 10;

export async function GET() {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({
    webhooks: await listWebhookSubscriptions(actor.db, actor.userId),
    eventTypes: WEBHOOK_EVENT_TYPES,
  });
}

export async function POST(req: Request) {
  const actor = await resolveAgentContext();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!(await rateLimit(`webhook-create:${actor.userId}`, 10, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  let body: { url?: unknown; events?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  const events = normalizeWebhookEvents(body.events);
  if (events.length === 0) {
    return NextResponse.json({ error: "Choose at least one event to send." }, { status: 400 });
  }

  const existing = await listWebhookSubscriptions(actor.db, actor.userId);
  if (existing.length >= MAX_SUBSCRIPTIONS) {
    return NextResponse.json(
      { error: `You already have ${MAX_SUBSCRIPTIONS} webhooks. Delete one first.` },
      { status: 400 },
    );
  }

  const created = await createWebhookSubscription(actor.db, {
    managerUserId: actor.userId,
    url: String(body.url ?? ""),
    events,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });

  // `secret` is returned here and from rotate, and nowhere else, ever.
  return NextResponse.json({ webhook: created.subscription, secret: created.secret }, { status: 201 });
}
