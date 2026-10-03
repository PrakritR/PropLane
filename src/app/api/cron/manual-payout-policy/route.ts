import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureManualPayoutPolicy } from "@/lib/manual-payout-policy.server";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";
export const runtime = "nodejs";
export const maxDuration = 300;
/** Bounded, resumable conversion of existing connected accounts. Never changes bank destinations. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const { data: rows, error } = await db.from("profiles").select("id, stripe_connect_account_id").not("stripe_connect_account_id", "is", null).is("manual_payout_policy_at", null).order("id").limit(100);
  if (error) return NextResponse.json({ error: "Could not read payout policy queue." }, { status: 500 });
  let converted = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    try {
      if ((await resolveTestWorkspaceClassification(row.id, db)).kind === "normal") {
        await ensureManualPayoutPolicy(getStripe(), row.stripe_connect_account_id);
      }
      const result = await db.from("profiles").update({ manual_payout_policy_at: new Date().toISOString() }).eq("id", row.id).eq("stripe_connect_account_id", row.stripe_connect_account_id);
      if (result.error) throw result.error;
      converted += 1;
    } catch { failed += 1; }
  }
  return NextResponse.json({ converted, failed, remainingBatch: rows?.length === 100 }, { status: failed ? 500 : 200 });
}
