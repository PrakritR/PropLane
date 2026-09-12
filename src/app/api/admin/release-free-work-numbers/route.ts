import { NextResponse } from "next/server";

import { isAdminUser } from "@/lib/auth/admin-preview";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { releaseManagerNumber } from "@/lib/sms/manager-number-provisioning.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { releaseTwilioNumber } from "@/lib/twilio-provisioning";

export const runtime = "nodejs";

/**
 * Round 3 plan model, "release on deploy": a work number is a paid feature,
 * so the numbers that Free accounts hold from the earlier every-plan policy
 * are released. Run ONCE per environment by staff after the deploy that
 * ships the plan model — never on a page load, never on a schedule.
 *
 * Body `{ dryRun?: boolean }`: `dryRun: true` (the default) lists what would
 * be released and touches nothing. Only an explicit `dryRun: false` releases
 * — the Twilio number first (so a carrier line is never billed for an account
 * that cannot use it), then the row is marked released. A Twilio refusal
 * leaves the row untouched and is reported per account.
 *
 * Paid, trial, comp and unreadable plans are skipped: only an account whose
 * EFFECTIVE plan resolves to Free loses its line, and an unreadable plan is
 * not Free.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await isAdminUser(user.id))) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

    const body = (await req.json().catch(() => ({}))) as { dryRun?: unknown };
    const dryRun = body.dryRun !== false;

    const db = createSupabaseServiceRoleClient();
    const { data: rows, error } = await db
      .from("manager_sms_numbers")
      .select("manager_user_id, phone_number, phone_number_sid, provision_state")
      .neq("provision_state", "released");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const released: Array<{ managerUserId: string; phoneNumber: string | null }> = [];
    const skipped: Array<{ managerUserId: string; reason: string }> = [];
    const failed: Array<{ managerUserId: string; error: string }> = [];

    for (const row of rows ?? []) {
      const managerUserId = String(row.manager_user_id ?? "");
      if (!managerUserId) continue;
      const tier = await getEffectiveManagerSkuTier(managerUserId);
      if (!tier.ok) {
        skipped.push({ managerUserId, reason: "plan_unreadable" });
        continue;
      }
      if (tier.tier !== "free") {
        skipped.push({ managerUserId, reason: `plan_${tier.tier ?? "unknown"}` });
        continue;
      }
      if (dryRun) {
        released.push({ managerUserId, phoneNumber: (row.phone_number as string | null) ?? null });
        continue;
      }
      const sid = (row.phone_number_sid as string | null) ?? null;
      const twilioOk = sid ? await releaseTwilioNumber(sid) : true;
      if (!twilioOk) {
        failed.push({ managerUserId, error: "twilio_release_failed" });
        continue;
      }
      await releaseManagerNumber(db, managerUserId);
      released.push({ managerUserId, phoneNumber: (row.phone_number as string | null) ?? null });
    }

    return NextResponse.json({ ok: true, dryRun, released, skipped, failed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to release numbers." }, { status: 500 });
  }
}
