/**
 * Retry pass for outbound webhook deliveries whose backoff has elapsed.
 *
 * Guarded exactly like the other cron routes: a `CRON_SECRET` bearer when one
 * is configured, and open only on a non-production runtime so local development
 * can drive it by hand.
 */
import { NextResponse } from "next/server";

import { retryDueWebhookDeliveries } from "@/lib/webhooks/deliver.server";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return secret ? req.headers.get("authorization") === `Bearer ${secret}` : !isProductionRuntime();
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await retryDueWebhookDeliveries(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Webhook retry failed." },
      { status: 500 },
    );
  }
}
