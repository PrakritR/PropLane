/**
 * Checkr Tenant API webhook receiver. Optional: the manager UI already polls
 * for status, but a `report.completed` webhook gives instant propagation
 * without polling — preferred once check volume grows. Point Checkr's webhook
 * at `{NEXT_PUBLIC_APP_URL}/api/webhooks/screening/checkr`.
 *
 * Host-independent: the signature is the only check, so the same endpoint answers on every host that serves this
 * app (proplane.ai and the legacy axis-seattle-housing.com). The legacy-host redirect in middleware never touches
 * `/api/**` or a non-GET request (`shouldRedirectLegacyHostVisitor`), so a webhook is never 308'd off the host.
 *
 * Untrusted input: verify the signature before trusting the payload, then
 * re-fetch the order/report by id from Checkr rather than trusting any
 * status/result fields in the payload itself.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { applyBackgroundCheckReport } from "@/lib/checkr/background-check";
import { fetchBackgroundCheckReport } from "@/lib/checkr/client";
import { checkrWebhookSecrets } from "@/lib/checkr/config";
import { applyPreApplyCheckReport } from "@/lib/screening/preapply.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const REPLAY_TOLERANCE_SECONDS = 5 * 60;

/** `Tenant-Signature: t=<unix_ts>,v1=<hex hmac of "<t>.<raw body>">` */
function verifySignature(rawBody: string, header: string | null, secrets: readonly string[]): boolean {
  // Only local dev may run without a configured secret — any deployed
  // environment (Vercel, including preview/staging) must fail closed.
  if (secrets.length === 0) return !process.env.VERCEL;
  if (!header?.trim()) return false;
  const parts = Object.fromEntries(
    header.split(",").map((piece) => piece.trim().split("=") as [string, string]),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > REPLAY_TOLERANCE_SECONDS) return false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
    try {
      if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return true;
    } catch {
      // length mismatch — try next secret
    }
  }
  return false;
}

/** Checkr dashboard "Test webhook" sends a bare POST with no body or signature. */
function isConnectivityProbe(rawBody: string, signature: string | null): boolean {
  return !rawBody.trim() && !signature?.trim();
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("tenant-signature") ?? req.headers.get("Tenant-Signature");

    if (isConnectivityProbe(rawBody, signature)) {
      return NextResponse.json({ ok: true, probe: true });
    }

    if (!verifySignature(rawBody, signature, checkrWebhookSecrets())) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
    }

    const payload = JSON.parse(rawBody) as {
      type?: string;
      data?: { id?: string; order_id?: string };
    };
    const orderId =
      typeof payload.data?.order_id === "string" ? payload.data.order_id : typeof payload.data?.id === "string" ? payload.data.id : null;

    // Any report.* / order.* event names an order. Nothing in the payload is trusted for state: the order and its
    // report are re-fetched from Checkr below and THAT status is applied (completion, cancellation, still pending).
    // Anything else (candidate/account events) is acknowledged and ignored.
    const type = typeof payload.type === "string" ? payload.type : "";
    if (!/^(report|order)\./.test(type)) return NextResponse.json({ ok: true, ignored: true });

    if (!orderId) {
      console.error("checkr webhook: order event had no resolvable orderId", { type: payload.type });
      return NextResponse.json({ ok: true, ignored: true });
    }

    const report = await fetchBackgroundCheckReport(orderId);
    if (!report) return NextResponse.json({ ok: true, ignored: true });

    const db = createSupabaseServiceRoleClient();
    const reportFacts = {
      status: report.status,
      result: report.result,
      reportSnapshot: report.reportSnapshot,
      reportResourceId: report.reportResourceId,
    };
    // An order the applicant placed before applying lives in its own record (and keeps it after it is stamped onto
    // an application); the application row, once there is one, is updated below as always.
    const preApplyHeld = await applyPreApplyCheckReport(db, orderId, reportFacts);
    const row = await applyBackgroundCheckReport(db, orderId, reportFacts);
    if (!row && preApplyHeld) return NextResponse.json({ ok: true, preapply: true });
    if (!row) {
      console.error("checkr webhook: report.completed resolved orderId but no matching application", { orderId });
      return NextResponse.json({ ok: true, ignored: true });
    }
    return NextResponse.json({ ok: true, applicationId: row.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Webhook failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
