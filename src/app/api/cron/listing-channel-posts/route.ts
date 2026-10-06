import { NextResponse } from "next/server";

import { processListingChannelQueue } from "@/lib/listing-channels/sync.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Retries queued listing-site posts (publish / update / unpublish). Quiet and instant when no channel is live. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || (req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await processListingChannelQueue(createSupabaseServiceRoleClient(), { limit: 25 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "failed" }, { status: 500 });
  }
}
