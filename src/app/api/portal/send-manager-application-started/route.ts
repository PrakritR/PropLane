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
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { track } from "@/lib/analytics/posthog";

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

function canSendManagerApplicationStarted(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

/** Manager fills an application on behalf of a resident — preview or send the started email. */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    let body: { applicationId?: unknown; preview?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });
    const previewOnly = body.preview === true;

    const svc = createSupabaseServiceRoleClient();
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (requestorError) return NextResponse.json({ error: requestorError.message }, { status: 500 });
    const admin = await isAdminUser(user.id);
    if (!admin && !canSendManagerApplicationStarted(requestor?.role)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }

    const { data: records, error } = await svc
      .from("manager_application_records")
      .select("id, row_data, resident_email")
      .in("id", idVariants(applicationId));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const record = (records ?? []).find((r) => idVariants(applicationId).includes(r.id));
    if (!record?.row_data) {
      return NextResponse.json({ error: "Application not found." }, { status: 404 });
    }

    const row = record.row_data as DemoApplicantRow;
    if (!admin && !applicationVisibleToPortalUser(row, user.id)) {
      return NextResponse.json({ error: "You do not manage this application." }, { status: 403 });
    }
    if (!isInProgressApplicationRow(row)) {
      return NextResponse.json({ error: "Only in-progress applications can receive this email." }, { status: 400 });
    }

    const email = (row.email?.trim() || record.resident_email?.trim() || "").toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "This application has no valid applicant email on file." }, { status: 400 });
    }

    const ensured = await ensureResidentSetupTokenForApplication(svc, record.id);
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

    if (previewOnly) {
      return NextResponse.json({
        ok: true,
        preview: { to: email, subject: APPLICATION_STARTED_EMAIL_SUBJECT, text },
      });
    }

    if (shouldSkipOutboundEmail(email)) {
      return NextResponse.json({ ok: true, skipped: true });
    }

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
    const dedupId = `application_started_email_${normalizeApplicationAxisId(record.id)}`;
    await svc.from("portal_outbound_mail_records").upsert(
      {
        id: dedupId,
        recipient_email: email,
        subject: APPLICATION_STARTED_EMAIL_SUBJECT,
        channel: "email",
        row_data: { id: dedupId, to: email, sentAt, axisId: ensured.axisId, sentByManager: true },
      },
      { onConflict: "id" },
    );

    const nextRow: DemoApplicantRow = { ...row, startedSetupEmailSentAt: sentAt };
    await svc
      .from("manager_application_records")
      .update({ row_data: sealApplicantRow(nextRow, record.id, row.managerUserId), updated_at: sentAt })
      .eq("id", record.id);

    track("manager_application_started_email_sent", user.id, { has_property: Boolean(row.propertyId) });
    return NextResponse.json({ ok: true, id: payload.id ?? null, setupHref: buildResidentSetupHref(ensured.token, ensured.axisId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send application email." },
      { status: 500 },
    );
  }
}
