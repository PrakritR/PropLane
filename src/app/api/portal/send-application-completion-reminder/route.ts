import { NextResponse } from "next/server";
import {
  APPLICATION_COMPLETION_REMINDER_SUBJECT,
  buildApplicationCompletionReminderBody,
  buildApplicationCompletionReminderHtml,
  buildApplicationCompletionReminderMailtoHref,
} from "@/lib/application-completion-reminder-email";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  inProgressApplicationResumeUrl,
  shouldOfferApplicationCompletionReminder,
} from "@/lib/rental-application/in-progress-application";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

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

function canSendApplicationReminder(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

/** Fill gaps in stored row_data so incomplete drafts match client-side eligibility. */
function hydrateApplicationRowForReminder(
  row: DemoApplicantRow,
  record: { resident_email?: string | null; property_id?: string | null },
): DemoApplicantRow {
  const email = row.email?.trim() || record.resident_email?.trim() || row.email;
  const propertyId = row.propertyId?.trim() || record.property_id?.trim() || row.propertyId;
  return {
    ...row,
    bucket: row.bucket ?? "pending",
    ...(email ? { email } : {}),
    ...(propertyId ? { propertyId } : {}),
  };
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    let body: { applicationId?: unknown; preview?: unknown; viaEmail?: unknown; viaSms?: unknown; subject?: unknown; text?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });
    // Preview mode returns exactly what would be sent (same auth, recipient, and copy)
    // so the manager can confirm before a real email goes out — nothing is sent.
    const previewOnly = body.preview === true;

    const svc = createSupabaseServiceRoleClient();
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (requestorError) return NextResponse.json({ error: requestorError.message }, { status: 500 });
    const admin = await isAdminUser(user.id);
    if (!admin && !canSendApplicationReminder(requestor?.role)) {
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

    const row = hydrateApplicationRowForReminder(
      record.row_data as DemoApplicantRow,
      record,
    );
    if (!shouldOfferApplicationCompletionReminder(row)) {
      return NextResponse.json({ error: "Only incomplete applications can receive a completion reminder." }, { status: 400 });
    }

    if (!admin && !applicationVisibleToPortalUser(row, user.id)) {
      return NextResponse.json({ error: "You do not manage this application." }, { status: 403 });
    }

    const email = (row.email?.trim() || record.resident_email?.trim() || "").toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "This application has no valid applicant email on file." }, { status: 400 });
    }

    const origin = appOrigin();
    const resumeUrl = inProgressApplicationResumeUrl(origin, row);
    const signInUrl = `${origin}/auth/sign-in?role=resident`;
    const defaultText = buildApplicationCompletionReminderBody({
      applicantName: row.name || undefined,
      propertyTitle: row.property || undefined,
      resumeUrl,
      signInUrl,
    });
    const subjectOverride =
      typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : APPLICATION_COMPLETION_REMINDER_SUBJECT;
    const textOverride =
      typeof body.text === "string" && body.text.trim() ? body.text.trim() : defaultText;
    const html =
      textOverride === defaultText
        ? buildApplicationCompletionReminderHtml({
            applicantName: row.name || undefined,
            propertyTitle: row.property || undefined,
            resumeUrl,
            signInUrl,
          })
        : `<!DOCTYPE html><html><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.55;color:#0f172a;white-space:pre-wrap">${textOverride.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</body></html>`;
    const mailtoHref = buildApplicationCompletionReminderMailtoHref({
      to: email,
      applicantName: row.name || undefined,
      propertyTitle: row.property || undefined,
      resumeUrl,
      signInUrl,
      subject: subjectOverride,
      bodyText: textOverride,
    });

    if (previewOnly) {
      return NextResponse.json({
        ok: true,
        preview: { to: email, subject: subjectOverride, text: textOverride },
      });
    }

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Email delivery is not configured.", mailtoHref }, { status: 503 });
    }

    const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: subjectOverride, text: textOverride, html }),
    });
    const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: payload.message ?? res.statusText, mailtoHref }, { status: 502 });
    }
    // Server-confirmed outcome: the manager successfully nudged an in-progress applicant.
    track("application_completion_reminder_sent", user.id, { has_property: Boolean(row.propertyId) });
    return NextResponse.json({ ok: true, id: payload.id ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send reminder." },
      { status: 500 },
    );
  }
}
