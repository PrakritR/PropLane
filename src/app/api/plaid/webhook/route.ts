import { NextResponse, after } from "next/server";
import { plaidEnabled } from "@/lib/plaid/client.server";
import { verifyPlaidWebhook } from "@/lib/plaid/webhook-verify.server";
import { handlePlaidWebhookEvent } from "@/lib/plaid/webhook-events.server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Plaid webhooks. The RAW body is hashed and the `Plaid-Verification` JWT (ES256, key by kid,
 * iat within five minutes, body SHA-256) is checked BEFORE any JSON is trusted. Anything that
 * fails is refused with 401 and does nothing.
 */
export async function POST(req: Request) {
  if (!plaidEnabled()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const rawBody = await req.text();
  const verdict = await verifyPlaidWebhook(rawBody, req.headers.get("plaid-verification"));
  if (!verdict.ok) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });

  let event: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    event = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    event = null;
  }
  if (!event) return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  // Acknowledge fast; the sync runs after the response.
  after(async () => {
    try {
      await handlePlaidWebhookEvent(event);
    } catch {
      /* the daily cron picks the item up again */
    }
  });
  return NextResponse.json({ ok: true });
}
