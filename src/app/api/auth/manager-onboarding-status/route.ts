import { managerNeedsPricingSelection } from "@/lib/auth/manager-onboarding";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function oauthFullName(meta: Record<string, unknown> | null | undefined): string | null {
  const fullName = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  return name || null;
}

export async function GET() {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user?.id || !user.email) {
      return NextResponse.json({ needsPricing: false, authenticated: false });
    }

    const service = createSupabaseServiceRoleClient();
    const needsPricing = await managerNeedsPricingSelection(service, user.id, user.email, {
      emailVerified: Boolean(user.email_confirmed_at),
    });
    const provider =
      (typeof user.app_metadata?.provider === "string" ? user.app_metadata.provider : null) ??
      (user.app_metadata?.providers as string[] | undefined)?.[0] ??
      user.identities?.[0]?.provider ??
      "email";

    return NextResponse.json({
      needsPricing,
      authenticated: true,
      email: user.email.trim().toLowerCase(),
      fullName: oauthFullName(user.user_metadata),
      provider,
      isGoogle: provider === "google",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
