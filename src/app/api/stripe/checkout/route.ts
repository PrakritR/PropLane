import { NextResponse } from "next/server";
import { ensureProvisionedManagerForPricing } from "@/lib/auth/manager-pricing-selection";
import { createManagerCheckoutSession } from "@/lib/stripe/manager-checkout";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

type Tier = "pro" | "business";
type Billing = "monthly" | "annual";

type Body = {
  tier?: string;
  billing?: string;
  email?: string;
  fullName?: string;
  phone?: string;
  promo?: string;
  embedded?: boolean;
};

function isTier(s: string): s is Tier {
  return s === "pro" || s === "business";
}

function isBilling(s: string): s is Billing {
  return s === "monthly" || s === "annual";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const tierRaw = typeof body.tier === "string" ? body.tier.toLowerCase().trim() : "";
    const billingRaw = typeof body.billing === "string" ? body.billing.toLowerCase().trim() : "";

    if (!tierRaw || !billingRaw) {
      return NextResponse.json({ error: "tier and billing are required." }, { status: 400 });
    }
    if (!isTier(tierRaw)) {
      return NextResponse.json({ error: "tier must be \"pro\" or \"business\"." }, { status: 400 });
    }
    if (!isBilling(billingRaw)) {
      return NextResponse.json({ error: "billing must be \"monthly\" or \"annual\"." }, { status: 400 });
    }

    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user: authUser },
    } = await supabaseAuth.auth.getUser();

    let managerId: string | undefined;
    let userId: string | undefined;
    let checkoutEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (authUser?.id) {
      userId = authUser.id;
      const email = authUser.email?.trim().toLowerCase() ?? "";
      const supabase = createSupabaseServiceRoleClient();
      if ((await resolveTestWorkspaceClassification(authUser.id, supabase)).kind !== "normal") {
        return NextResponse.json({ error: "This action is unavailable." }, { status: 403 });
      }
      if (email) {
        checkoutEmail = email;
        const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
        const prepared = await ensureProvisionedManagerForPricing(supabase, {
          userId: authUser.id,
          email,
          fullName: fullName || null,
        });
        if (prepared.kind === "complete") {
          // Account already fully set up — client should send them to portal.
          return NextResponse.json({ alreadyComplete: true, redirectTo: "/portal/dashboard" }, { status: 409 });
        }
        managerId = prepared.managerId;
      }
    }

    const result = await createManagerCheckoutSession({
      tier: tierRaw,
      billing: billingRaw,
      email: checkoutEmail,
      fullName: body.fullName,
      phone: body.phone,
      userId,
      managerId,
      promo: body.promo,
      embedded: body.embedded,
      req,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }

    if (result.embedded) {
      return NextResponse.json({ clientSecret: result.clientSecret, sessionId: result.sessionId });
    }

    return NextResponse.json({ url: result.url, sessionId: result.sessionId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Checkout failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
