/**
 * Inbound support-email webhook — the public support address's front door.
 *
 * Mail to support@prop-lane.space is routed to Resend Inbound, which POSTs an
 * `email.received` event here (Svix-signed). We verify the signature and write the
 * thread row INLINE, so a failed write answers 5xx and Resend retries instead of
 * the mail vanishing behind an early ack; only the body enrichment runs in
 * after(). Otherwise it mirrors the Twilio SMS webhook's posture: nodejs runtime,
 * fail-closed on Vercel, in-memory rate limit, service-role Supabase client.
 *
 * Configure in the Resend dashboard:
 *   • Receiving → add the MX record so support@prop-lane.space routes to Resend
 *   • Webhooks → subscribe `email.received` to
 *       {APP_URL}/api/webhooks/email/inbound
 *   • Set RESEND_INBOUND_WEBHOOK_SECRET to that endpoint's signing secret (whsec_…)
 * See docs/agents/inbound-email-inbox.md for the full captain-side runbook.
 */
import { after } from "next/server";
import {
  backfillInboundEmailBody,
  ingestInboundEmail,
  parseInboundEmailWebhook,
} from "@/lib/inbound-email/inbound-email.server";
import {
  backfillInboundEmailReplyBody,
  ingestInboundEmailReply,
} from "@/lib/inbound-email/inbound-email-reply.server";
import {
  ingestInboundEmailSmsReply,
  type EmailSmsReplyResult,
} from "@/lib/inbound-email/inbound-email-sms-reply.server";
import { parseReplyAddress, parseSmsReplyAddress } from "@/lib/inbound-email/reply-address.server";
import { isPaymentInboxEmail } from "@/lib/payment-receipt-email/payment-inbox";
import { processInboundPaymentReceiptEmail } from "@/lib/payment-receipt-email/process-receipt.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { verifyResendWebhookSignature } from "@/lib/inbound-email/verify-signature";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Bounded constant key — the shared rateLimit map never evicts, so never interpolate here. */
const GLOBAL_RATE_LIMIT_KEY = "email-inbound:instance";

function ok(extra?: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...extra });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim();
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  // Fail closed on any deployed environment. Only local dev may run unsigned
  // (no secret configured / no signature headers) — mirrors the Twilio route.
  if (!secret || !svixSignature) {
    if (process.env.VERCEL) return new Response("Forbidden", { status: 403 });
  } else {
    const verified = verifyResendWebhookSignature({
      rawBody: raw,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      secret,
    });
    if (!verified) return new Response("Forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return ok({ ignored: "unparseable" });
  }

  const parsed = parseInboundEmailWebhook(payload);
  // Non-inbound events (deliveries, bounces, connectivity probes) ack quietly.
  if (!parsed) return ok({ ignored: "not-received" });

  // Two shed valves, both acking 200 (a non-2xx makes the provider retry,
  // amplifying a flood) and both logged so a dropped message is diagnosable.
  //
  // Coarse instance-wide backstop first: the per-sender key below is
  // attacker-chosen, so a flood rotating its From would otherwise never trip a
  // limit — and checking the aggregate first also bounds how many per-sender
  // buckets a single window can mint.
  if (!rateLimit(GLOBAL_RATE_LIMIT_KEY, 300, 60_000).ok) {
    console.warn("inbound-email rate-limited (instance)", parsed.fromEmail, parsed.emailId);
    return ok({ rateLimited: "instance" });
  }
  // Per-SENDER valve — every request arrives from Resend's own IPs, so an
  // IP-keyed bucket would be a global ceiling one noisy sender could exhaust for
  // everyone.
  if (!rateLimit(`email-inbound:${parsed.fromEmail}`, 120, 60_000).ok) {
    console.warn("inbound-email rate-limited", parsed.fromEmail, parsed.emailId);
    return ok({ rateLimited: true });
  }

  // A verified SMS-conversation reply token (`sms+…`, distinct prefix from the
  // portal `reply+…` token) routes the mail onward as a TEXT from the
  // manager's work number. Failures inside the ingest bounce back to the
  // manager by email — only an unresolvable token owner falls through to the
  // support ingest so the mail stays visible.
  const smsReply = parseSmsReplyAddress(parsed.toEmails, parsed.fromEmail);
  if (smsReply) {
    const result: EmailSmsReplyResult = await ingestInboundEmailSmsReply(parsed, smsReply).catch(
      (e) => {
        console.error("inbound-email sms reply ingest failed", parsed.emailId, e);
        return { handled: true, sent: false, error: "ingest_error" };
      },
    );
    if (result.handled) {
      return ok({
        smsReply: true,
        sent: result.sent,
        ...(result.idempotent ? { idempotent: true } : {}),
      });
    }
    // Token owner no longer resolves — fall through to the support ingest.
  }

  // A verified reply token routes the mail into its portal conversation
  // thread instead of the support inbox. Anything that fails verification
  // (foreign domain, tampered MAC, mismatched From) falls through to the
  // support ingest below — visible in the admin inbox, never trusted or lost.
  const reply = parseReplyAddress(parsed.toEmails, parsed.fromEmail);
  if (reply) {
    let handled: boolean;
    let appended: boolean;
    try {
      ({ handled, appended } = await ingestInboundEmailReply(parsed, reply.ownerUserId));
    } catch (e) {
      // 5xx → Resend redelivers; the deterministic message id keeps it idempotent.
      console.error("inbound-email reply ingest failed", parsed.emailId, e);
      return new Response("Ingest failed", { status: 500 });
    }
    if (handled) {
      const enrichReply = () =>
        backfillInboundEmailReplyBody(parsed, reply.ownerUserId).catch((e) =>
          console.warn("inbound-email reply body backfill errored", parsed.emailId, e),
        );
      try {
        after(enrichReply);
      } catch {
        void enrichReply();
      }
      return appended ? ok({ reply: true }) : ok({ reply: true, idempotent: true });
    }
    // Token owner no longer resolves — fall through to the support ingest.
  }

  if (isPaymentInboxEmail(parsed.toEmails)) {
    const processReceipt = () =>
      processInboundPaymentReceiptEmail(parsed, createSupabaseServiceRoleClient())
        .then((result) => {
          if (result.outcome === "marked_paid") {
            console.info(
              "payment-receipt marked paid",
              result.emailId,
              result.chargeId,
              result.channel,
            );
          } else if (result.outcome === "no_match" || result.outcome === "ambiguous") {
            console.warn("payment-receipt unmatched", result);
          }
        })
        .catch((e) => console.warn("payment-receipt processing errored", parsed.emailId, e));
    try {
      after(processReceipt);
    } catch {
      void processReceipt();
    }
    return ok({ paymentInbox: true });
  }

  let created: boolean;
  try {
    ({ created } = await ingestInboundEmail(parsed));
  } catch (e) {
    // Never a silent drop: 5xx makes Resend redeliver, and the deterministic
    // thread id keeps that retry idempotent.
    console.error("inbound-email ingest failed", parsed.emailId, e);
    return new Response("Ingest failed", { status: 500 });
  }

  // The mail is safely stored; fetching its body is enrichment, so it runs off
  // the response path — where it can afford to retry, since acking 200 means no
  // redelivery is coming to try again for us.
  const enrich = () =>
    backfillInboundEmailBody(parsed).catch((e) =>
      console.warn("inbound-email body backfill errored", parsed.emailId, e),
    );
  try {
    after(enrich);
  } catch {
    void enrich();
  }

  return created ? ok() : ok({ idempotent: true });
}
