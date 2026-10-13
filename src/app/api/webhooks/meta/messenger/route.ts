import { after, NextResponse } from "next/server";

import { extractMessengerInbound, handleMessengerInbound, verifyMetaWebhookSignature } from "@/lib/listing-channels/meta/messenger.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Meta's webhook verification handshake. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (expected && params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === expected) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

/** Page messages. The HMAC over the raw body is the credential; the work runs after the 200. */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyMetaWebhookSignature(raw, request.headers.get("x-hub-signature-256"), process.env.META_APP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  const events = extractMessengerInbound(payload);
  if (events.length > 0) {
    // Meta only needs a fast 200; the work is idempotent (message id + the 24h claim), so Meta's retries are safe.
    const work = async () => {
      const db = createSupabaseServiceRoleClient();
      for (const event of events) {
        await handleMessengerInbound(db, event).catch((e) => console.warn("meta messenger event failed", e instanceof Error ? e.message : e));
      }
    };
    after(work);
  }
  return NextResponse.json({ ok: true });
}
