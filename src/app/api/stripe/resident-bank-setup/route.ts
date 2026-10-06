import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { assertTestWorkspaceProviderEffectAllowed, TestWorkspaceProviderDisabledError } from "@/lib/test-workspaces/effects.server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";

export const runtime = "nodejs";

function statusOf(intent: Stripe.SetupIntent) {
  if (intent.status === "requires_action" && intent.next_action?.type === "verify_with_microdeposits") return "verification";
  if (intent.status === "succeeded") return "paid";
  if (intent.status === "requires_payment_method" || intent.status === "requires_confirmation") return "entry";
  return "review";
}

async function scopedSetup(id: string) {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.email) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error } = await db.from("profiles").select("stripe_customer_id, role").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { error: NextResponse.json({ error: "Resident access required." }, { status: 403 }) };
  }
  await assertTestWorkspaceProviderEffectAllowed({ userId: user.id, kind: "payment",
    summary: "Saved bank verification refused for a test workspace.", db });
  const customerId = profile?.stripe_customer_id?.trim();
  if (!customerId) return { error: NextResponse.json({ error: "Bank setup is not yours." }, { status: 403 }) };
  const stripe = getStripe();
  const intent = await stripe.setupIntents.retrieve(id);
  const intentCustomerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (intent.metadata?.resident_user_id !== user.id || intent.metadata?.resident_payment_flow !== "saved_bank" ||
      intentCustomerId !== customerId || !intent.payment_method_types.includes("us_bank_account")) {
    return { error: NextResponse.json({ error: "Bank setup is not yours." }, { status: 403 }) };
  }
  return { stripe, intent };
}

function failed(error: unknown) {
  if (error instanceof TestWorkspaceProviderDisabledError) {
    return NextResponse.json({ error: "Payments are unavailable for test accounts." }, { status: 403 });
  }
  return NextResponse.json({ error: "Bank setup needs review." }, { status: 409 });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("setup_intent_id")?.trim();
  try {
    if (!id) {
      const auth = await createSupabaseServerClient();
      const { data: { user } } = await auth.auth.getUser();
      if (!user?.email) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
      const db = createSupabaseServiceRoleClient();
      const { data: profile, error } = await db.from("profiles")
        .select("stripe_customer_id, role").eq("id", user.id).maybeSingle();
      if (error || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
        return NextResponse.json({ error: "Resident access required." }, { status: 403 });
      }
      const customerId = profile?.stripe_customer_id?.trim();
      if (!customerId) return NextResponse.json({ bankStatus: "none" });
      await assertTestWorkspaceProviderEffectAllowed({ userId: user.id, kind: "payment",
        summary: "Saved bank verification refused for a test workspace.", db });
      const stripe = getStripe();
      const intents = await stripe.setupIntents.list({ customer: customerId, limit: 100 });
      const pending = intents.data.find(intent => intent.status === "requires_action" &&
        intent.next_action?.type === "verify_with_microdeposits" &&
        intent.metadata?.resident_user_id === user.id &&
        intent.metadata?.resident_payment_flow === "saved_bank" &&
        (typeof intent.customer === "string" ? intent.customer : intent.customer?.id) === customerId);
      return pending?.client_secret
        ? NextResponse.json({ bankStatus: "verification", setupIntentId: pending.id,
          clientSecret: pending.client_secret })
        : intents.has_more
          ? NextResponse.json({ error: "Bank setup history needs review." }, { status: 409 })
        : NextResponse.json({ bankStatus: "none" });
    }
    const result = await scopedSetup(id);
    if (result.error) return result.error;
    return NextResponse.json({ bankStatus: statusOf(result.intent!), setupIntentId: id,
      clientSecret: result.intent!.client_secret });
  } catch (error) { return failed(error); }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as
    { setupIntentId?: unknown; descriptorCode?: unknown; amounts?: unknown } | null;
  const id = typeof body?.setupIntentId === "string" ? body.setupIntentId.trim() : "";
  const code = typeof body?.descriptorCode === "string" ? body.descriptorCode.trim().toUpperCase() : "";
  const amounts = body?.amounts;
  const validAmounts = Array.isArray(amounts) && amounts.length === 2 &&
    amounts.every(value => Number.isSafeInteger(value) && value > 0 && value < 100);
  if (!id || (Boolean(code) === validAmounts) || (code && !/^SM[A-Z0-9]{4}$/.test(code))) {
    return NextResponse.json({ error: "Enter the bank verification code or two deposit amounts." }, { status: 400 });
  }
  try {
    const result = await scopedSetup(id);
    if (result.error) return result.error;
    if (result.intent?.status !== "requires_action" || result.intent.next_action?.type !== "verify_with_microdeposits") {
      return NextResponse.json({ error: "This bank account is not awaiting verification." }, { status: 409 });
    }
    const verified = await result.stripe!.setupIntents.verifyMicrodeposits(id,
      code ? { descriptor_code: code } : { amounts: amounts as number[] });
    return NextResponse.json({ bankStatus: statusOf(verified), setupIntentId: id });
  } catch (error) { return failed(error); }
}
