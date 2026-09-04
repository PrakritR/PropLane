import { NextResponse } from "next/server";
import { retryDueActionEventDeliveries } from "@/lib/action-events.server";
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
    const result = await retryDueActionEventDeliveries(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action-event retry failed." },
      { status: 500 },
    );
  }
}
