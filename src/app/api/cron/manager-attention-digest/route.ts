import { NextResponse } from "next/server";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import {
  deliverManagerAttentionDigest,
  managerAttentionDigestDue,
} from "@/lib/manager-attention-digest.server";
import { normalizeManagerAttentionDigestCadence } from "@/lib/manager-notification-preferences";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const now = new Date();
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("manager_user_id,digest_cadence:row_data->>managerAttentionDigestCadence")
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const row of data ?? []) {
    const managerUserId = String(row.manager_user_id ?? "").trim();
    const cadence = normalizeManagerAttentionDigestCadence(row.digest_cadence);
    if (!managerUserId || cadence === "off" || !managerAttentionDigestDue(cadence, now)) {
      skipped++;
      continue;
    }
    try {
      const result = await deliverManagerAttentionDigest({
        db,
        managerUserId,
        cadence,
        portalUrl: `${resolveShareableAppOrigin()}/portal`,
        now,
      });
      if (result.sent) sent++;
      else skipped++;
    } catch (cause) {
      errors.push(`${managerUserId}:${cause instanceof Error ? cause.message : "failed"}`);
    }
  }

  return NextResponse.json({ ok: errors.length === 0, sent, skipped, errors: errors.slice(0, 25) });
}
