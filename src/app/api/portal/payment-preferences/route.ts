import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveStripePayoutContext } from "@/lib/auth/manager-stripe-payout-access.server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import { loadManagerManualPaymentSettings, saveManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
async function context(level: "read" | "edit") {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Sign in required." }, { status: 401 }) };
  const db = createSupabaseServiceRoleClient();
  const payout = await resolveStripePayoutContext(db, user.id);
  if (!payout.payoutOwnerUserId) return { error: NextResponse.json({ error: "Choose a workspace." }, { status: 409 }) };
  const access = await assertCoManagerBankAccountAccess(db, user.id, payout.payoutOwnerUserId, level);
  if (!access.ok) return { error: NextResponse.json({ error: access.error }, { status: access.status }) };
  return { db, owner: payout.payoutOwnerUserId };
}
export async function GET() {
  try {
    const ctx = await context("read"); if (ctx.error) return ctx.error;
    const settings = await loadManagerManualPaymentSettings(ctx.db!, ctx.owner!);
    return NextResponse.json({ defaultPaymentSource: settings.defaultPaymentSource ?? "balance" });
  } catch { return NextResponse.json({ error: "Could not load payment preferences." }, { status: 500 }); }
}
export async function PATCH(req: Request) {
  try {
    const ctx = await context("edit"); if (ctx.error) return ctx.error;
    const body = await req.json();
    if (body.defaultPaymentSource !== "balance" && body.defaultPaymentSource !== "bank") return NextResponse.json({ error: "Choose Balance or Bank." }, { status: 400 });
    const settings = await loadManagerManualPaymentSettings(ctx.db!, ctx.owner!);
    const saved = await saveManagerManualPaymentSettings(ctx.db!, ctx.owner!, { ...settings, defaultPaymentSource: body.defaultPaymentSource });
    return NextResponse.json({ defaultPaymentSource: saved.defaultPaymentSource ?? "balance" });
  } catch { return NextResponse.json({ error: "Could not save payment preferences." }, { status: 500 }); }
}
