import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { track } from "@/lib/analytics/posthog";
import {
  findPendingVendorInviteByToken,
  provisionVendorAccountByEmail,
  vendorUnlinkedNotice,
  type VendorInviteRow,
} from "@/lib/auth/provision-vendor-account";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = { token?: string };

export async function POST(req: Request) {
  try {
    const { token } = (await req.json()) as Body;
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user?.id || !user.email) {
      return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const recovery = await recoverySetupRedirect(service, user.id);
    if (recovery) return NextResponse.json({ ok: true, recoveryRequired: true, redirectTo: recovery });
    let invite: VendorInviteRow | null = null;
    const trimmedToken = token?.trim() ?? "";

    if (trimmedToken) {
      invite = await findPendingVendorInviteByToken(service, trimmedToken);
      if (!invite) {
        return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
      }
      const inviteEmail = invite.vendor_email.trim().toLowerCase();
      const oauthEmail = user.email.trim().toLowerCase();
      if (inviteEmail !== oauthEmail) {
        return NextResponse.json(
          {
            error:
              "This invite is for a different email address. Sign in with Google using the email your manager invited.",
          },
          { status: 403 },
        );
      }
    }

    const fullName =
      typeof user.user_metadata?.full_name === "string"
        ? user.user_metadata.full_name
        : typeof user.user_metadata?.name === "string"
          ? user.user_metadata.name
          : invite?.vendor_name ?? null;

    const result = await provisionVendorAccountByEmail(service, {
      userId: user.id,
      email: user.email,
      fullName,
      invite,
      confirmEmail: true,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    track("vendor_account_created", user.id, {
      signup_method: trimmedToken ? "oauth_invite" : "oauth",
    });

    return NextResponse.json({
      ok: true,
      axisId: result.axisId,
      linkedManagerId: result.linkedManagerId,
      unlinkedReason: result.unlinkedReason,
      unlinkedNotice: vendorUnlinkedNotice(result.unlinkedReason, { confirmed: true }),
      redirectTo: "/vendor/dashboard",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
