import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { coerceResidentPaymentMethodForSurface } from "@/lib/platform/resident-payments";
import { readNativePlatformHeader } from "@/lib/platform/native-client";
import type { ResidentAxisPaymentMethod } from "@/lib/payment-policy";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";

export const runtime = "nodejs";

type Body = {
  chargeId?: string;
  chargeIds?: string[];
  embedded?: boolean;
  paymentMethod?: ResidentAxisPaymentMethod;
};

function normalizePaymentMethod(raw: unknown, isNativeApp: boolean): ResidentAxisPaymentMethod {
  /* Link is never offered — a client that still asks for it is refused rather
     than silently charged on another method. */
  if (raw === "link") throw new Error("Link checkout is unavailable. Choose card or bank account.");
  const method: ResidentAxisPaymentMethod = raw === "card" ? "card" : "ach";
  return coerceResidentPaymentMethodForSurface(method, isNativeApp);
}

/**
 * Creates Stripe Checkout for one or more pending household charges via ACH.
 * The validation + session-creation core lives in
 * `@/lib/stripe-household-charge-checkout.server` (shared with the resident
 * agent's start_rent_payment tool); this route only authenticates and maps the
 * result onto HTTP responses.
 */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    const useEmbedded = body.embedded !== false;
    const isNativeApp = readNativePlatformHeader(req) !== null;
    const paymentMethod = normalizePaymentMethod(body.paymentMethod, isNativeApp);
    const requestedIds = [
      ...(Array.isArray(body.chargeIds) ? body.chargeIds : []),
      ...(typeof body.chargeId === "string" ? [body.chargeId] : []),
    ];

    const db = createSupabaseServiceRoleClient();
    const { data: profile, error: profileError } = await db.from("profiles")
      .select("role").eq("id", user.id).maybeSingle();
    if (profileError || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
      return NextResponse.json({ error: "Resident access required." }, { status: 403 });
    }
    const result = await createHouseholdChargeCheckout(db, {
      userId: user.id,
      userEmail: (user.email ?? "").trim().toLowerCase(),
      chargeIds: requestedIds,
      mode: useEmbedded ? "embedded" : "hosted",
      paymentMethod,
      appOrigin: resolveAppOrigin(req),
    });

    if (!result.ok) {
      return NextResponse.json(
        { ...(result.code ? { code: result.code } : {}), error: result.error },
        { status: result.status },
      );
    }

    if (result.mode === "manual_ach") {
      return NextResponse.json({
        mode: result.mode,
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        bankStatus: result.bankStatus,
        sessionId: result.sessionId,
        amountCents: result.amountCents,
        subtotalCents: result.subtotalCents,
        processingFeeCents: result.processingFeeCents,
        axisFeeCents: result.axisFeeCents,
        platformFeeCents: result.platformFeeCents,
        totalCents: result.totalCents,
        paymentMethod: result.paymentMethod,
        chargeIds: result.chargeIds,
      });
    }
    if (result.mode === "embedded") {
      return NextResponse.json({
        clientSecret: result.clientSecret,
        sessionId: result.sessionId,
        amountCents: result.amountCents,
        subtotalCents: result.subtotalCents,
        processingFeeCents: result.processingFeeCents,
        axisFeeCents: result.axisFeeCents,
        platformFeeCents: result.platformFeeCents,
        totalCents: result.totalCents,
        paymentMethod: result.paymentMethod,
        chargeIds: result.chargeIds,
      });
    }

    return NextResponse.json({
      url: result.url,
      sessionId: result.sessionId,
      amountCents: result.amountCents,
      subtotalCents: result.subtotalCents,
      processingFeeCents: result.processingFeeCents,
      axisFeeCents: result.axisFeeCents,
      platformFeeCents: result.platformFeeCents,
      totalCents: result.totalCents,
      paymentMethod: result.paymentMethod,
      chargeIds: result.chargeIds,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Checkout failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
