import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { track } from "@/lib/analytics/posthog";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import {
  claimVendorInvite,
  findPendingVendorInviteByToken,
  provisionVendorAccountByEmail,
  releaseVendorInvite,
  vendorUnlinkedNotice,
  type VendorInviteRow,
} from "@/lib/auth/provision-vendor-account";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { normalizeE164 } from "@/lib/twilio";

export const runtime = "nodejs";

type Body = {
  token?: string;
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
};

/** Invite-link preview — lets the register page show/lock the invited email without trusting the client for it. */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return NextResponse.json({ error: "Missing invite token." }, { status: 400 });
  }
  const supabase = createSupabaseServiceRoleClient();
  const invite = await findPendingVendorInviteByToken(supabase, token);
  if (!invite) {
    return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
  }
  return NextResponse.json({ email: invite.vendor_email, name: invite.vendor_name ?? "" });
}

/**
 * Store the vendor's phone once the account exists.
 *
 * provisionVendorAccountByEmail does not take a phone, and widening its
 * contract from here would touch every caller. Writing it explicitly keeps the
 * change to this route — and a failure here must never fail the signup: the
 * account is already created, and the number is optional.
 */
async function applyVendorPhone(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string | null | undefined,
  phone: string,
): Promise<void> {
  if (!userId || !phone) return;
  try {
    await supabase.from("profiles").update({ phone }).eq("id", userId);
  } catch {
    /* optional field — never block account creation on it */
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    // Required (phone-first accounts): every account, invited or self-serve, puts its number in. Normalised so a stored
    // number is always E.164, never whatever the keypad produced.
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "") ?? "";

    if (!phone) {
      return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();

    if (token) {
      const confirmEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const auth = await createSupabaseServerClient();
      const { data: { user } } = await auth.auth.getUser();
      if (!user?.id || !user.email_confirmed_at || !user.email) return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
      return await registerFromInvite(supabase, { token, fullName, phone, confirmEmail, userId: user.id, verifiedEmail: user.email.trim().toLowerCase() });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.id || !user.email_confirmed_at || user.email?.trim().toLowerCase() !== email) {
      return NextResponse.json({ error: "Verify your email and sign in before continuing.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    }
    return await registerSelfServe(supabase, { email, userId: user.id, fullName, phone });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create vendor account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** An invite authorizes the vendor relationship, not ownership of its email. */
async function registerFromInvite(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  opts: { token: string; fullName: string; phone?: string; confirmEmail?: string; userId: string; verifiedEmail: string },
) {
  const invite = await findPendingVendorInviteByToken(supabase, opts.token);
  if (!invite) {
    return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
  }
  const email = invite.vendor_email.trim().toLowerCase();
  if (opts.verifiedEmail !== email) return NextResponse.json({ error: "Sign in with the verified email used on the invite.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
  if (opts.confirmEmail && opts.confirmEmail !== email) {
    return NextResponse.json(
      { error: "This invite was sent to a different email address." },
      { status: 400 },
    );
  }

  const existingId = await findAuthUserIdByEmail(supabase, email);
  if (existingId !== opts.userId) return NextResponse.json({ error: "Verify your email and sign in before continuing." }, { status: 403 });
  const recovery = await recoverySetupRedirect(supabase, opts.userId);
  if (recovery) return NextResponse.json({ ok: true, existingAccount: true, recoveryRequired: true, redirectTo: recovery });

  // Claim FIRST. Two concurrent redemptions of the same token both used to pass
  // the pending check and both proceed, because the flip to `accepted` happened
  // at the very end of provisioning.
  const claimed = await claimVendorInvite(supabase, invite.id, null);
  if (!claimed) {
    return NextResponse.json({ error: "This invite has already been used." }, { status: 409 });
  }

  const userId = opts.userId;

  const provisioned = await provisionVendorAccountByEmail(supabase, {
    userId,
    email,
    fullName: opts.fullName || null,
    invite: invite as VendorInviteRow,
    confirmEmail: true,
  });
  if (!provisioned.ok) {
    // Hand the invite back: this failure was not the invitee's doing, and a
    // burned token would leave them with no way in and the manager unaware.
    await releaseVendorInvite(supabase, invite.id);
    return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
  }

  await applyVendorPhone(supabase, userId, opts.phone ?? "");

  track("vendor_account_created", userId, { signup_method: "invite" });

  return NextResponse.json({
    ok: true,
    confirmed: true,
    axisId: provisioned.axisId,
    linkedManagerId: provisioned.linkedManagerId,
    unlinkedReason: provisioned.unlinkedReason,
    unlinkedNotice: vendorUnlinkedNotice(provisioned.unlinkedReason, { confirmed: true }),
    redirectTo: "/vendor/onboarding",
  });
}

/** Self-serve role provisioning requires the authenticated, verified mailbox owner. */
async function registerSelfServe(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  opts: { email: string; userId: string; fullName: string; phone?: string },
) {
  const existingId = await findAuthUserIdByEmail(supabase, opts.email);
  if (existingId !== opts.userId) {
    return NextResponse.json({ error: "Verify your email and sign in before continuing." }, { status: 403 });
  }
  const recovery = await recoverySetupRedirect(supabase, existingId);
  if (recovery) return NextResponse.json({ ok: true, existingAccount: true, recoveryRequired: true, redirectTo: recovery });
  const provisioned = await provisionVendorAccountByEmail(supabase, {
    userId: existingId,
    email: opts.email,
    fullName: opts.fullName || null,
  });
  if (!provisioned.ok) return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
  await applyVendorPhone(supabase, existingId, opts.phone ?? "");
  track("vendor_account_created", existingId, { signup_method: "self_serve_existing_account" });
  return NextResponse.json({ ok: true, confirmed: true, axisId: provisioned.axisId,
    linkedManagerId: provisioned.linkedManagerId, unlinkedReason: provisioned.unlinkedReason,
    unlinkedNotice: vendorUnlinkedNotice(provisioned.unlinkedReason, { confirmed: true }),
    redirectTo: "/vendor/onboarding" });
}
