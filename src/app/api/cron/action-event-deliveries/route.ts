import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";
import { retryDueActionEventDeliveries } from "@/lib/action-events.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await retryDueActionEventDeliveries(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action-event retry failed." },
      { status: 500 },
    );
  }
}
