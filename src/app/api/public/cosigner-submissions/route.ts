import { NextResponse } from "next/server";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationLinkBlock } from "@/lib/rental-application/application-link-eligibility";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { notifyManagerCosignerSubmitted } from "@/lib/cosigner-notification.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function makeCosignerId(): string {
  return `cosigner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stripSensitiveForStorage(sub: CosignerSubmission): CosignerSubmission {
  return {
    ...sub,
    ssn: sub.ssn ? `***-**-${sub.ssn.replace(/\D/g, "").slice(-4) || "****"}` : "",
  };
}

export async function POST(req: Request) {
  try {
    if (!rateLimit(`cosigner-submission:${clientIpFrom(req)}`, 10, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = (await req.json()) as Partial<CosignerSubmission>;
    const signerAppId = normalizeApplicationAxisId(String(body.signerAppId ?? "").trim());
    if (!signerAppId) {
      return NextResponse.json({ error: "Application ID is required." }, { status: 400 });
    }
    if (!body.fullName?.trim() || !body.email?.trim()) {
      return NextResponse.json({ error: "Co-signer name and email are required." }, { status: 400 });
    }
    if (!body.consentCredit) {
      return NextResponse.json({ error: "Credit check consent is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const variants = [signerAppId, signerAppId.toUpperCase(), body.signerAppId?.trim()].filter(Boolean);
    const { data: appRow } = await db
      .from("manager_application_records")
      .select("id, manager_user_id, row_data")
      .in("id", variants)
      .maybeSingle();

    if (!appRow) {
      return NextResponse.json({ error: "Application ID not found. Check the application ID from the primary applicant." }, { status: 404 });
    }

    const blocked = applicationLinkBlock(appRow.row_data as DemoApplicantRow);
    if (blocked) {
      return NextResponse.json({ error: blocked.message }, { status: 403 });
    }

    const linkedSignerAppId = String(appRow.id ?? "").trim() || signerAppId;

    const submission: CosignerSubmission = {
      signerAppId: linkedSignerAppId,
      signerFullName: String(body.signerFullName ?? "").trim(),
      fullName: String(body.fullName).trim(),
      email: String(body.email).trim().toLowerCase(),
      phone: String(body.phone ?? "").trim(),
      dob: String(body.dob ?? "").trim(),
      dlNumber: String(body.dlNumber ?? "").trim(),
      ssn: String(body.ssn ?? "").trim(),
      address: String(body.address ?? "").trim(),
      city: String(body.city ?? "").trim(),
      state: String(body.state ?? "").trim(),
      zip: String(body.zip ?? "").trim(),
      notEmployed: Boolean(body.notEmployed),
      employerName: String(body.employerName ?? "").trim(),
      employerAddress: String(body.employerAddress ?? "").trim(),
      supervisorName: String(body.supervisorName ?? "").trim(),
      supervisorPhone: String(body.supervisorPhone ?? "").trim(),
      jobTitle: String(body.jobTitle ?? "").trim(),
      monthlyIncome: String(body.monthlyIncome ?? "").trim(),
      annualIncome: String(body.annualIncome ?? "").trim(),
      employmentStart: String(body.employmentStart ?? "").trim(),
      otherIncome: String(body.otherIncome ?? "").trim(),
      bankruptcy: String(body.bankruptcy ?? "").trim(),
      criminal: String(body.criminal ?? "").trim(),
      consentCredit: true,
      signature: String(body.signature ?? "").trim(),
      dateSigned: String(body.dateSigned ?? "").trim(),
      submittedAt: new Date().toISOString(),
    };

    const id = makeCosignerId();
    const stored = stripSensitiveForStorage(submission);
    const managerUserId = appRow.manager_user_id as string | null;

    const { error } = await db.from("cosigner_submission_records").insert({
      id,
      signer_app_id: linkedSignerAppId,
      manager_user_id: managerUserId,
      row_data: stored,
      updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const appData = appRow.row_data as { name?: string; property?: string } | null;
    void notifyManagerCosignerSubmitted({
      managerUserId,
      signerAppId: linkedSignerAppId,
      primaryApplicantName: appData?.name,
      propertyTitle: appData?.property,
      cosignerName: submission.fullName,
      cosignerEmail: submission.email,
    }).catch(() => undefined);

    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save co-signer submission.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
