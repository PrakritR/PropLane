import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildPasswordResetEmailBody,
  buildPasswordResetEmailHtml,
  PASSWORD_RESET_SUBJECT,
} from "@/lib/auth/password-reset-email";
import { passwordResetConfirmUrl } from "@/lib/auth/password-reset-url";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Generic reply for every outcome a caller must not be able to tell apart:
 * account exists, account does not exist, account is OAuth-only. Anything else
 * leaks which emails are registered.
 */
const GENERIC_OK = { ok: true } as const;

/**
 * "No user with this email" is the ordinary case, not an incident — it is what every
 * probe of a non-customer's address looks like. Everything else from GoTrue means the
 * mint itself is broken and an operator needs to see it.
 */
function isUnknownAddressError(error: { message?: string; status?: number }): boolean {
  if (error.status === 404) return true;
  return /user not found/i.test(error.message ?? "");
}

/**
 * Send a password-reset email.
 *
 * This replaces `supabase.auth.resetPasswordForEmail` on the client. That call
 * starts a PKCE flow whose `code_verifier` is stored in the requesting browser,
 * so the emailed link only worked if it was opened in that same browser — opening
 * it from Gmail on another device failed with "PKCE code verifier not found in
 * storage" and dumped the user on the sign-in page. Here the server mints the
 * recovery token itself and mails a `token_hash` link, which `verifyOtp` accepts
 * from any browser. The token keeps Supabase's own expiry (~1h) and single use.
 */
export async function POST(req: Request) {
  let email = "";
  try {
    const body = (await req.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter the email you use to sign in." }, { status: 400 });
  }

  // Two buckets: one stops an attacker walking a list of addresses, the other stops
  // a victim's inbox being flooded from many IPs. Both fail closed with the generic
  // reply so neither doubles as an account-existence oracle.
  //
  // Known gap (follow-up axis-durable-reset-throttle): these buckets are per-process
  // in-memory, so on Vercel concurrent requests land on separate instances with fresh
  // buckets and the per-address cap can be multiplied. Blast radius is unwanted mail
  // and burnt Resend quota; the fix belongs in the shared limiter, not here.
  const ipOk = (await rateLimit(`password-reset:ip:${clientIpFrom(req)}`, 10, 10 * 60_000)).ok;
  const emailOk = (await rateLimit(`password-reset:email:${email}`, 3, 10 * 60_000)).ok;
  if (!ipOk || !emailOk) {
    return NextResponse.json(GENERIC_OK);
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Email delivery is not configured. Contact support to reset your password." },
      { status: 503 },
    );
  }

  let tokenHash: string | undefined;
  try {
    const supabase = createSupabaseServiceRoleClient();
    // supabase-js reports API failures by RETURNING an error, not by throwing, so
    // dropping `error` here would let a revoked service-role key or a paused project
    // fall through to the unknown-address branch below — reset dead in production while
    // every call still answers {ok:true}. The caller's reply stays generic either way
    // (a distinguishable one would be an account-existence oracle); the difference is
    // that an operator gets a log line.
    const { data, error } = await supabase.auth.admin.generateLink({ type: "recovery", email });
    if (error && !isUnknownAddressError(error)) {
      console.error("Password reset link minting failed:", error.message);
    }
    tokenHash = data?.properties?.hashed_token;
  } catch (thrown) {
    // Missing/malformed service-role env, or a transport error.
    console.error(
      "Password reset link minting threw:",
      thrown instanceof Error ? thrown.message : "unknown error",
    );
    return NextResponse.json(GENERIC_OK);
  }
  if (!tokenHash) {
    // Unknown address is the common case here and must look identical to success.
    // The token itself is never logged — it is a live credential until it is used.
    return NextResponse.json(GENERIC_OK);
  }

  const resetLink = passwordResetConfirmUrl(resolveEmailLinkBaseUrl(), tokenHash);
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: PASSWORD_RESET_SUBJECT,
        text: buildPasswordResetEmailBody({ resetLink }),
        html: buildPasswordResetEmailHtml({ resetLink }),
      }),
    });
    if (!res.ok) {
      // Log the status only — the body can echo the recipient, and the link (which
      // carries the token) must never reach a log line. The caller still gets the
      // generic reply: a distinguishable failure would only ever be reachable for an
      // address that exists, which is exactly the oracle this route must not be.
      console.error("Password reset email send failed with status", res.status);
      return NextResponse.json(GENERIC_OK);
    }
  } catch {
    console.error("Password reset email send failed before a response was received");
    return NextResponse.json(GENERIC_OK);
  }

  return NextResponse.json(GENERIC_OK);
}
