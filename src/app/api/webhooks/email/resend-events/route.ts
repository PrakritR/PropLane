/**
 * Resend delivery-event webhook: marks the inbox message an email belongs to Delivered or Not delivered.
 *
 * Resend POSTs `email.delivered` / `email.bounced` / `email.complained` (Svix-signed) with `data.email_id`, the
 * id the send path recorded in `inbox_message_provider_refs`. Fails CLOSED: with no `RESEND_WEBHOOK_SECRET` the
 * route answers 503, with a missing or bad signature 401; nothing is ever accepted unsigned, locally included.
 * Idempotent: a redelivered event advances nothing twice, and an id nobody recorded is acked and ignored.
 *
 * Configure in the Resend dashboard: Webhooks → subscribe `email.delivered`, `email.bounced`,
 * `email.complained` to {APP_URL}/api/webhooks/email/resend-events, and set RESEND_WEBHOOK_SECRET to that
 * endpoint's signing secret (whsec_…). `email.delivery_delayed` is ignored: the message stays Sent.
 */
import { verifyResendWebhookSignature } from "@/lib/inbound-email/verify-signature";
import { mapResendEvent } from "@/lib/inbox-delivery-status";
import { applyProviderDeliveryStatus } from "@/lib/inbox-delivery-status.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response("Resend webhook not configured", { status: 503 });

  const raw = await req.text();
  const verified = verifyResendWebhookSignature({
    rawBody: raw,
    headers: {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    secret,
  });
  if (!verified) return new Response("Invalid signature", { status: 401 });

  let payload: { type?: unknown; data?: { email_id?: unknown } } | null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ ok: true, ignored: "unparseable" });
  }
  const mapped = mapResendEvent(typeof payload?.type === "string" ? payload.type : null);
  const emailId = typeof payload?.data?.email_id === "string" ? payload.data.email_id.trim() : "";
  if (!mapped || !emailId) return Response.json({ ok: true, ignored: "not-a-delivery-event" });

  try {
    const result = await applyProviderDeliveryStatus(createSupabaseServiceRoleClient(), {
      providerId: emailId,
      channel: "email",
      status: mapped.status,
      error: mapped.error,
    });
    return Response.json({ ok: true, updated: result.updated });
  } catch {
    // A 5xx makes Resend retry; the update is idempotent, so a retry is safe.
    return new Response("Delivery status unavailable", { status: 503 });
  }
}
