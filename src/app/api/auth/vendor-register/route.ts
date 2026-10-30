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
import { assertPasswordMatchesExistingAuthUser } from "@/lib/auth/verify-auth-password";
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
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    // Required (phone-first accounts): every account, invited or self-serve, puts its number in. Normalised so a stored
    // number is always E.164, never whatever the keypad produced.
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "") ?? "";

    if (!phone) {
      return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    }
    if (token && password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();

    if (token) {
      const confirmEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      return await registerFromInvite(supabase, { token, password, fullName, phone, confirmEmail });
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

/**
 * Invite path — the emailed link is the possession proof, so the account is
 * confirmed immediately. Two things guard that:
 *
 * - the address is taken from the INVITE, never from the request body, and a
 *   body that names a different one is refused rather than quietly ignored, so
 *   the token can never be redeemed toward an address the manager did not name;
 * - the invite is claimed atomically before anything is provisioned, so the
 *   token is single-use in fact and not merely by convention.
 */
async function registerFromInvite(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  opts: { token: string; password: string; fullName: string; phone?: string; confirmEmail?: string },
) {
  const invite = await findPendingVendorInviteByToken(supabase, opts.token);
  if (!invite) {
    return NextResponse.json({ error: "This invite link is invalid or has expired." }, { status: 404 });
  }
  const email = invite.vendor_email.trim().toLowerCase();
  if (opts.confirmEmail && opts.confirmEmail !== email) {
    return NextResponse.json(
      { error: "This invite was sent to a different email address." },
      { status: 400 },
    );
  }

  const existingId = await findAuthUserIdByEmail(supabase, email);
  const recovery = existingId ? await recoverySetupRedirect(supabase, existingId) : null;
  if (recovery) {
    const verified = await assertPasswordMatchesExistingAuthUser(email, opts.password);
    if (!verified.ok) return NextResponse.json({ error: verified.message }, { status: 401 });
    return NextResponse.json({ ok: true, existingAccount: true, recoveryRequired: true, redirectTo: recovery });
  }

  // Claim FIRST. Two concurrent redemptions of the same token both used to pass
  // the pending check and both proceed, because the flip to `accepted` happened
  // at the very end of provisioning.
  const claimed = await claimVendorInvite(supabase, invite.id, null);
  if (!claimed) {
    return NextResponse.json({ error: "This invite has already been used." }, { status: 409 });
  }

  const { userId, error } = await createOrLinkAuthUser(supabase, {
    email,
    password: opts.password,
    fullName: opts.fullName,
    emailConfirm: true,
  });
  if (error) {
    await releaseVendorInvite(supabase, invite.id);
    return error;
  }

  const provisioned = await provisionVendorAccountByEmail(supabase, {
    userId: userId!,
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

  track("vendor_account_created", userId!, { signup_method: "invite" });

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

async function createOrLinkAuthUser(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  opts: { email: string; password: string; fullName: string; emailConfirm: boolean },
): Promise<{ userId?: string; error?: NextResponse }> {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: opts.emailConfirm,
    user_metadata: { role: "vendor", full_name: opts.fullName || undefined },
  });

  if (!createErr) {
    if (!created?.user?.id) {
      return { error: NextResponse.json({ error: "Could not create account." }, { status: 500 }) };
    }
    return { userId: created.user.id };
  }

  const exists =
    createErr.message.toLowerCase().includes("already") || createErr.message.toLowerCase().includes("registered");
  if (!exists) {
    return { error: NextResponse.json({ error: createErr.message }, { status: 400 }) };
  }
  const existingId = await findAuthUserIdByEmail(supabase, opts.email);
  if (!existingId) {
    return {
      error: NextResponse.json({ error: "Could not locate existing account for this email." }, { status: 400 }),
    };
  }
  const pwCheck = await assertPasswordMatchesExistingAuthUser(opts.email, opts.password);
  if (!pwCheck.ok) {
    return { error: NextResponse.json({ error: pwCheck.message }, { status: 401 }) };
  }
  return { userId: existingId };
}

