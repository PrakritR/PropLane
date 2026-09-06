import { NextResponse } from "next/server";
import { ensureResidentSetupTokenForApplication } from "@/lib/auth/resident-setup-token";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildResidentWelcomeEmailBody,
  buildResidentWelcomeEmailHtml,
  residentAccountCreationUrl,
} from "@/lib/resident-welcome-email";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Resend the resident account-setup link for someone who applied but lost the
 * email. Unauthenticated + rate limited: the setup token is NEVER returned to the
 * browser — it only leaves via email to the address on the application — so a
 * caller who guesses an email cannot obtain a claim capability for it. The
 * response is deliberately neutral (always `ok: true` when an email is well
 * formed) so it does not reveal whether an application exists for that address.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`resident-setup-link:${clientIpFrom(req)}`, 5, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    let body: { email?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: rows, error } = await db
      .from("manager_application_records")
      .select("id")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const axisId = rows?.[0]?.id;
    // No application on file — respond as if we sent one (no enumeration).
    if (!axisId) return NextResponse.json({ ok: true, sent: false });

    const ensured = await ensureResidentSetupTokenForApplication(db, axisId);
    if (!ensured.ok) return NextResponse.json({ ok: true, sent: false });

    // Sandbox / demo addresses never receive real mail.
    if (shouldSkipOutboundEmail(email)) return NextResponse.json({ ok: true, sent: false, skipped: true });

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      // Neutral to the client; honest in the payload flag for callers that care.
      return NextResponse.json({ ok: true, sent: false, emailConfigured: false });
    }

    const origin = resolveEmailLinkBaseUrl();
    const signupUrl = residentAccountCreationUrl(origin, ensured.axisId, ensured.token);
    const text = buildResidentWelcomeEmailBody({ axisId: ensured.axisId, signupUrl });
    const html = buildResidentWelcomeEmailHtml({ axisId: ensured.axisId, signupUrl });
    const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: RESIDENT_WELCOME_EMAIL_SUBJECT, text, html }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      return NextResponse.json({ ok: false, error: payload.message ?? res.statusText }, { status: 502 });
    }
    return NextResponse.json({ ok: true, sent: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not send setup link." },
      { status: 500 },
    );
  }
}
