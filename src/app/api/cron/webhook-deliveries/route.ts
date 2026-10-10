/**
 * Retry pass for outbound webhook deliveries whose backoff has elapsed.
 *
 * Guarded exactly like the other cron routes (`requireCronSecret`): a `CRON_SECRET`
 * bearer when one is configured, and with no secret configured only a localhost/test
 * run, so local development can drive it by hand and a deployment never can.
 */
import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";

import { retryDueWebhookDeliveries } from "@/lib/webhooks/deliver.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
