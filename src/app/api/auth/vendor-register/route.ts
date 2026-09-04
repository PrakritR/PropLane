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
import { mayLogVendorConfirmLinkLocally } from "@/lib/auth/vendor-register-local-dev";
import { resolveAppOrigin } from "@/lib/app-url";
import {
  buildVendorSignupConfirmEmailBody,
  buildVendorSignupConfirmEmailHtml,
  VENDOR_SIGNUP_CONFIRM_SUBJECT,
} from "@/lib/vendor-signup-confirm-email";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = {
  token?: string;
  email?: string;
  password?: string;
  fullName?: string;
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";

    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();

    if (token) {
      const confirmEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      return await registerFromInvite(supabase, { token, password, fullName, confirmEmail });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    return await registerSelfServe(req, supabase, { email, password, fullName });
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
  opts: { token: string; password: string; fullName: string; confirmEmail?: string },
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

  track("vendor_account_created", userId!, { signup_method: "invite" });

  return NextResponse.json({
    ok: true,
    confirmed: true,
    axisId: provisioned.axisId,
    linkedManagerId: provisioned.linkedManagerId,
    unlinkedReason: provisioned.unlinkedReason,
    unlinkedNotice: vendorUnlinkedNotice(provisioned.unlinkedReason, { confirmed: true }),
    redirectTo: "/vendor/dashboard",
  });
}

/** Self-serve path — no invite, so nothing proves the caller owns this email yet; require real confirmation. */
async function registerSelfServe(
  req: Request,
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  opts: { email: string; password: string; fullName: string },
) {
  const { email, password, fullName } = opts;
  const existingId = await findAuthUserIdByEmail(supabase, email);

  if (existingId) {
    // Signing into (and adding the vendor role to) an account that already exists —
    // the caller just proved ownership with the correct password.
    const pwCheck = await assertPasswordMatchesExistingAuthUser(email, password);
    if (!pwCheck.ok) {
      return NextResponse.json({ error: pwCheck.message }, { status: 401 });
    }
    const provisioned = await provisionVendorAccountByEmail(supabase, {
      userId: existingId,
      email,
      fullName: fullName || null,
    });
    if (!provisioned.ok) {
      return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
    }
    track("vendor_account_created", existingId, { signup_method: "self_serve_existing_account" });
    return NextResponse.json({
      ok: true,
      confirmed: true,
      axisId: provisioned.axisId,
      linkedManagerId: provisioned.linkedManagerId,
      // A stale invite never blocks an otherwise-legitimate sign-in; it is
      // reported so the vendor knows why no manager is attached.
      unlinkedReason: provisioned.unlinkedReason,
      unlinkedNotice: vendorUnlinkedNotice(provisioned.unlinkedReason, { confirmed: true }),
      redirectTo: "/vendor/dashboard",
    });
  }

  const origin = resolveAppOrigin(req);
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "signup",
    email,
    password,
    options: {
      data: { role: "vendor", full_name: fullName || undefined },
    },
  });
  if (linkErr || !linkData?.user?.id) {
    return NextResponse.json({ error: linkErr?.message ?? "Could not create account." }, { status: 400 });
  }

  const provisioned = await provisionVendorAccountByEmail(supabase, {
    userId: linkData.user.id,
    email,
    fullName: fullName || null,
    confirmEmail: false,
  });
  if (!provisioned.ok) {
    await rollbackSelfServeVendorSignup(supabase, linkData.user.id);
    return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
  }

  // Not yet a completed signup — the account can't sign in until the vendor confirms.
  track("vendor_signup_started", linkData.user.id, { signup_method: "self_serve" });

  // Build our own confirm link from the token hash rather than using `action_link`
  // (Supabase's hosted verify redirect, which appends session tokens as a URL hash) —
  // this app's browser client is PKCE-only, so it can't pick up an implicit-flow hash
  // fragment. `/auth/confirm` exchanges the hash via `verifyOtp`, which works either way.
  const confirmLink = `${origin}/auth/confirm?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=signup`;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const logConfirmLinkLocally = mayLogVendorConfirmLinkLocally(req);
  const createdUserId = linkData.user.id;

  const emailDeliveryFailure = async (errorMessage: string, status: number) => {
    if (!logConfirmLinkLocally) {
      await rollbackSelfServeVendorSignup(supabase, createdUserId);
    } else {
      console.info("[vendor-register] confirmation link (local dev only):", confirmLink);
    }
    return NextResponse.json(
      {
        error: errorMessage,
        ...(logConfirmLinkLocally ? { confirmLinkLoggedLocally: true } : {}),
      },
      { status },
    );
  };

  if (!apiKey) {
    return emailDeliveryFailure(
      logConfirmLinkLocally
        ? "Email delivery is not configured. Check the server console for a local confirmation link."
        : "Email delivery is not configured. Contact support to confirm your account.",
      503,
    );
  }

  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const text = buildVendorSignupConfirmEmailBody({ fullName, confirmLink });
  const html = buildVendorSignupConfirmEmailHtml({ fullName, confirmLink });
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: VENDOR_SIGNUP_CONFIRM_SUBJECT, text, html }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      return emailDeliveryFailure(
        payload.message ?? "Could not send the confirmation email. Try again or contact support.",
        502,
      );
    }
  } catch {
    return emailDeliveryFailure("Could not send the confirmation email.", 502);
  }

  return NextResponse.json({
    ok: true,
    confirmed: false,
    emailDeliveryConfigured: true,
    unlinkedReason: provisioned.unlinkedReason,
    unlinkedNotice: vendorUnlinkedNotice(provisioned.unlinkedReason, { confirmed: false }),
  });
}

/** Shared create-or-link for the invite path, where the email is server-resolved and trusted. */
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

/** Remove an unconfirmed self-serve vendor signup when confirmation email cannot be sent. */
async function rollbackSelfServeVendorSignup(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
): Promise<void> {
  try {
    await supabase.from("profile_roles").delete().eq("user_id", userId);
    await supabase.from("profiles").delete().eq("id", userId);
    await supabase.auth.admin.deleteUser(userId);
  } catch {
    /* best-effort — orphaned row is preferable to leaving a confirmable squat account */
  }
}
