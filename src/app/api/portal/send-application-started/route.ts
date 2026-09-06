import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { NextResponse } from "next/server";
import {
  APPLICATION_STARTED_EMAIL_SUBJECT,
  buildApplicationStartedEmailBody,
  buildApplicationStartedEmailHtml,
} from "@/lib/application-started-email";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  ensureResidentSetupTokenForApplication,
  buildResidentSetupHref,
} from "@/lib/auth/resident-setup-token";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { inProgressApplicationResumeUrl, isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))];
}

function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

/** Guest started an application — send resume + resident setup links once per application. */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`send-application-started:${clientIpFrom(req)}`, 12, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    let body: { email?: unknown; axisId?: unknown; setupToken?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }
    if (!axisId) return NextResponse.json({ error: "axisId is required." }, { status: 400 });
    if (shouldSkipOutboundEmail(email)) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    const db = createSupabaseServiceRoleClient();
    const dedupId = `application_started_email_${normalizeApplicationAxisId(axisId)}`;
    const { data: alreadySent } = await db.from("portal_outbound_mail_records").select("id").eq("id", dedupId).maybeSingle();
    if (alreadySent) {
      return NextResponse.json({ ok: true, alreadySent: true });
    }

    const { data: rows, error } = await db
      .from("manager_application_records")
      .select("id, resident_email, row_data")
      .in("id", idVariants(axisId));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const match = (rows ?? []).find((row) => (row.resident_email ?? "").trim().toLowerCase() === email);
    if (!match?.row_data) {
      return NextResponse.json({ error: "Application not found for this email and ID." }, { status: 403 });
    }

    const row = match.row_data as DemoApplicantRow;
    if (!isInProgressApplicationRow(row)) {
      return NextResponse.json({ error: "Application is no longer in progress." }, { status: 400 });
    }

    const ensured = await ensureResidentSetupTokenForApplication(db, match.id, {
      preferredToken: typeof body.setupToken === "string" ? body.setupToken : null,
    });
    if (!ensured.ok) {
      return NextResponse.json({ error: ensured.error }, { status: 500 });
    }

    const origin = appOrigin();
    const resumeUrl = inProgressApplicationResumeUrl(origin, ensured.row, {
      token: ensured.token,
      axisId: ensured.axisId,
    });
    const signupUrl = `${origin}${buildResidentSetupHref(ensured.token, ensured.axisId)}`;
    const text = buildApplicationStartedEmailBody({
      applicantName: row.name || undefined,
      propertyTitle: row.property || undefined,
      resumeUrl,
      signupUrl,
    });
    const html = buildApplicationStartedEmailHtml({
      applicantName: row.name || undefined,
      propertyTitle: row.property || undefined,
      resumeUrl,
      signupUrl,
    });

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Email delivery is not configured." }, { status: 503 });
    }

    const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: APPLICATION_STARTED_EMAIL_SUBJECT, text, html }),
    });
    const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: payload.message ?? res.statusText }, { status: 502 });
    }

    const sentAt = new Date().toISOString();
    await db.from("portal_outbound_mail_records").upsert(
      {
        id: dedupId,
        recipient_email: email,
        subject: APPLICATION_STARTED_EMAIL_SUBJECT,
        channel: "email",
        row_data: { id: dedupId, to: email, sentAt, axisId: ensured.axisId },
      },
      { onConflict: "id" },
    );

    const nextRow: DemoApplicantRow = { ...row, startedSetupEmailSentAt: sentAt };
    await db
      .from("manager_application_records")
      .update({ row_data: sealApplicantRow(nextRow, match.id, row.managerUserId), updated_at: sentAt })
      .eq("id", match.id);

    return NextResponse.json({ ok: true, id: payload.id ?? null, setupHref: buildResidentSetupHref(ensured.token, ensured.axisId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send started email." },
      { status: 500 },
    );
  }
}
