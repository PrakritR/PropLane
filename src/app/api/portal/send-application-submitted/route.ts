import { NextResponse } from "next/server";
import {
  applicationSubmittedEmailSubject,
  buildApplicationSubmittedEmailBody,
  buildApplicationSubmittedEmailHtml,
  buildApplicationSubmittedMailtoHref,
} from "@/lib/application-submitted-email";
import { notifyApplicantApplicationSms } from "@/lib/application-lifecycle-sms.server";
import {
  ensureResidentSetupTokenForApplication,
  buildResidentSetupHref,
  isResidentSetupTokenValid,
} from "@/lib/auth/resident-setup-token";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

// Domain is matched as dot-separated labels (no char class overlaps the "." delimiter)
// so there is exactly one way to parse a match — avoids polynomial backtracking on
// attacker-controlled input.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))];
}

// Emails link to the canonical domain only — never a *.vercel.app deploy URL.
function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

export async function POST(req: Request) {
  try {
    if (!rateLimit(`send-application-submitted:${clientIpFrom(req)}`, 10, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    let body: {
      email?: unknown;
      axisId?: unknown;
      applicantName?: unknown;
      propertyTitle?: unknown;
      includeSetupHandoff?: unknown;
      setupToken?: unknown;
      accountReady?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";
    const applicantName = typeof body.applicantName === "string" ? body.applicantName.trim() : "";
    const propertyTitle = typeof body.propertyTitle === "string" ? body.propertyTitle.trim() : "";
    const includeSetupHandoff = body.includeSetupHandoff === true;
    const accountReady = body.accountReady === true;
    const providedSetupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";

    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    if (!axisId) return NextResponse.json({ error: "axisId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data: rows, error } = await db
      .from("manager_application_records")
      .select("id, resident_email, row_data, manager_user_id")
      .in("id", idVariants(axisId));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const match = (rows ?? []).find((row) => (row.resident_email ?? "").trim().toLowerCase() === email);
    if (!match) {
      return NextResponse.json({ error: "Application not found for this email and ID." }, { status: 403 });
    }

    // When the caller (the guest wizard) already holds the setup token minted at
    // submit, reuse it verbatim so the emailed link matches the one already shown
    // on the finish screen. Rotating here would silently invalidate that link.
    // Fall back to a fresh (rotated) token for callers without one (e.g. resend).
    const matchRow = (match.row_data ?? {}) as Partial<DemoApplicantRow>;
    const reuseToken =
      providedSetupToken &&
      isResidentSetupTokenValid(
        {
          setupTokenHash: matchRow.setupTokenHash ?? null,
          setupTokenExpiresAt: matchRow.setupTokenExpiresAt ?? null,
          setupTokenConsumedAt: matchRow.setupTokenConsumedAt ?? null,
        },
        providedSetupToken,
      );

    let token: string | undefined;
    let ensuredAxisId: string;
    if (accountReady) {
      ensuredAxisId = normalizeApplicationAxisId(match.id);
    } else if (reuseToken) {
      token = providedSetupToken;
      ensuredAxisId = normalizeApplicationAxisId(match.id);
    } else {
      const ensured = await ensureResidentSetupTokenForApplication(db, match.id);
      if (!ensured.ok) {
        return NextResponse.json({ error: ensured.error }, { status: 500 });
      }
      token = ensured.token;
      ensuredAxisId = ensured.axisId;
    }

    const origin = appOrigin();
    const signupUrl = accountReady
      ? `${origin}/resident/applications`
      : residentAccountCreationUrl(origin, ensuredAxisId, token);
    const setupHref = token ? buildResidentSetupHref(token, ensuredAxisId) : undefined;
    const text = buildApplicationSubmittedEmailBody({
      applicantName: applicantName || undefined,
      applicantEmail: email,
      axisId: ensuredAxisId,
      signupUrl,
      propertyTitle: propertyTitle || undefined,
      accountReady,
    });
    const html = buildApplicationSubmittedEmailHtml({
      applicantName: applicantName || undefined,
      applicantEmail: email,
      axisId: ensuredAxisId,
      signupUrl,
      propertyTitle: propertyTitle || undefined,
      accountReady,
    });
    const mailtoHref = buildApplicationSubmittedMailtoHref({
      to: email,
      applicantName: applicantName || undefined,
      applicantEmail: email,
      axisId: ensuredAxisId,
      origin,
      propertyTitle: propertyTitle || undefined,
      setupToken: token,
      accountReady,
    });

    const rowData = (match.row_data ?? {}) as {
      application?: { phone?: string };
      name?: string;
    };
    const applicantPhone = String(rowData.application?.phone ?? "").trim() || null;
    const managerUserId = String(match.manager_user_id ?? "").trim() || null;

    // PropLane SMS (best-effort) — same moment as the confirmation email.
    // Deduped per application: this route is unauthenticated (axisId + email
    // pair), so without the guard anyone holding the pair could loop it to
    // SMS-bomb the applicant at platform cost.
    try {
      const smsDedupId = `application_submitted_sms_${ensuredAxisId}`;
      const { data: alreadySent } = await db
        .from("portal_outbound_mail_records")
        .select("id")
        .eq("id", smsDedupId)
        .maybeSingle();
      if (!alreadySent) {
        await db.from("portal_outbound_mail_records").upsert(
          {
            id: smsDedupId,
            recipient_email: email,
            subject: "Application submitted (SMS)",
            channel: "sms",
            row_data: {
              id: smsDedupId,
              to: applicantPhone,
              subject: "Application submitted (SMS)",
              sentAt: new Date().toISOString(),
              axisId: ensuredAxisId,
            },
          },
          { onConflict: "id" },
        );
        let fromNumber: string | null = null;
        if (managerUserId) {
          const { data: mgr } = await db
            .from("profiles")
            .select("sms_from_number")
            .eq("id", managerUserId)
            .maybeSingle();
          fromNumber = String(mgr?.sms_from_number ?? "").trim() || null;
        }
        await notifyApplicantApplicationSms(db, {
          event: "submitted",
          applicantEmail: email,
          applicantPhone,
          applicantName: applicantName || rowData.name || null,
          propertyTitle: propertyTitle || null,
          axisId: ensuredAxisId,
          signupUrl,
          managerUserId,
          fromNumber,
        });
      }
    } catch {
      /* non-critical */
    }

    // The setup token is a resident-account claim capability. It normally only
    // leaves via email. When includeSetupHandoff is true (guest wizard immediately
    // after submit), the same token is also returned to the client that proved
    // axisId+email ownership so account creation can continue without waiting
    // for email. Sandbox skip and unconfigured-email paths include it too.
    if (shouldSkipOutboundEmail(email)) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        mailtoHref,
        ...(includeSetupHandoff && setupHref ? { setupHref } : {}),
      });
    }

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "Email delivery is not configured.",
          mailtoHref,
          ...(includeSetupHandoff && setupHref ? { setupHref } : {}),
        },
        { status: 503 },
      );
    }

    const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: applicationSubmittedEmailSubject(accountReady), text, html }),
    });
    const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: payload.message ?? res.statusText,
          ...(includeSetupHandoff && setupHref ? { setupHref } : {}),
        },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      id: payload.id ?? null,
      ...(includeSetupHandoff ? { setupHref } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to send email." }, { status: 500 });
  }
}
