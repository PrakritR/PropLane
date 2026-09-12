import { NextResponse } from "next/server";
import { recoverProspectSmsBursts } from "@/lib/sms/prospect-sms-burst.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await recoverProspectSmsBursts(createSupabaseServiceRoleClient());
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed === 0 ? 200 : 503 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Prospect SMS burst recovery failed.",
    }, { status: 503 });
  }
}
