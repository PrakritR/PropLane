import { NextResponse } from "next/server";
import { sealCosignerIdentity } from "@/lib/security/cosigner-identity";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationLinkBlock } from "@/lib/rental-application/application-link-eligibility";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { notifyManagerCosignerSubmitted } from "@/lib/cosigner-notification.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  completeLinkedFormRequest,
  completeOpenLinkedFormRequestByForm,
  loadLinkedFormRequest,
  resolveLinkedFormViewerRole,
  type LinkedFormRequestRow,
} from "@/lib/application-linked-form-requests.server";
import { linkedFormFeeOwed, resolveUnresolvedLinkedFormFee } from "@/lib/linked-form-fee.server";
import { resolveCosignerTemplateForApplication } from "@/lib/rental-application/cosigner-template.server";
import { listingCustomApplicationFields, validateCustomFieldAnswers } from "@/lib/rental-application/custom-fields";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";
import { validateDateRequired, validateEmail, validateFullName, validatePhone10, validateSsn } from "@/app/(public)/rent/apply/apply-validation";
import { loadApplicantAccountIdentity } from "@/lib/rental-application/applicant-identity.server";
import { isWizardFormFieldEnabled, isWizardFormFieldRequired } from "@/lib/rental-application/application-field-catalog";

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
    if (!(await rateLimit(`cosigner-submission:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = (await req.json()) as Partial<CosignerSubmission> & { formRequestId?: unknown };

    // A form owed through a linked-form request: only a signed-in person with access to THAT request may
    // submit it, the application and template come from the stored request (never from the body), and the
    // person submitting must have paid its fee, if it has one.
    const formRequestId = typeof body.formRequestId === "string" ? body.formRequestId.trim() : "";
    let linkedRequest: LinkedFormRequestRow | null = null;
    let linkedUserId = "";
    let linkedUser: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null } | null = null;
    if (formRequestId) {
      const auth = await createSupabaseServerClient();
      const {
        data: { user },
      } = await auth.auth.getUser();
      if (!user) return NextResponse.json({ error: "Sign in to submit this form." }, { status: 401 });
      const lookupDb = createSupabaseServiceRoleClient();
      let found = await loadLinkedFormRequest(lookupDb, formRequestId);
      const viewer = found ? await resolveLinkedFormViewerRole(lookupDb, found, { id: user.id, email: user.email }) : null;
      if (!found || !viewer || viewer.role === "manager" || found.form_kind !== "application") {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      if (found.status !== "owed" && found.status !== "shared") {
        return NextResponse.json({ error: "This form is already finished." }, { status: 409 });
      }
      // `expires_at` is the SHARE LINK's life, not the form's: it is the deadline
      // `redeemLinkedFormToken` enforces when someone opens `/f/<token>`. An owed form never
      // expires for the applicant, and a helper who already redeemed a live link stays recognised
      // (`resolveLinkedFormViewerRole`) — a fresh link is minted on demand instead.
      // A fee that could not be read when the request was written is unresolved, never "no fee": resolve it
      // now from the stored listing, and refuse to complete the form when it still cannot be read.
      const feeResolved = await resolveUnresolvedLinkedFormFee(lookupDb, found);
      if (!feeResolved.ok) {
        return NextResponse.json({ error: "We could not confirm this form's fee. Please try again.", code: "FEE_UNRESOLVED" }, { status: 503 });
      }
      found = feeResolved.request;
      if (linkedFormFeeOwed(found) || ((found.fee_cents ?? 0) > 0 && found.fee_paid_by_user_id !== user.id)) {
        return NextResponse.json({ error: "Pay this form's fee to submit it.", code: "FEE_REQUIRED" }, { status: 402 });
      }
      linkedRequest = found;
      linkedUserId = user.id;
      linkedUser = user;
    }

    const signerAppId = normalizeApplicationAxisId(String(linkedRequest ? linkedRequest.application_id : (body.signerAppId ?? "")).trim());
    if (!signerAppId) {
      return NextResponse.json({ error: "Application ID is required." }, { status: 400 });
    }
    if (!body.consentCredit) {
      return NextResponse.json({ error: "Credit check consent is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const variants = [signerAppId, signerAppId.toUpperCase(), linkedRequest ? linkedRequest.application_id : body.signerAppId?.trim()].filter(Boolean);
    const { data: appRow } = await db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, row_data")
      .in("id", variants)
      .maybeSingle();

    if (!appRow) {
      return NextResponse.json({ error: "Application ID not found. Check the application ID from the primary applicant." }, { status: 404 });
    }

    const blocked = applicationLinkBlock(appRow.row_data as DemoApplicantRow);
    if (blocked) {
      return NextResponse.json({ error: blocked.message }, { status: 403 });
    }
    const managerUserId = appRow.manager_user_id as string | null;
    if (!managerUserId) return NextResponse.json({ error: "Application has no assigned manager." }, { status: 400 });

    const requestedTemplateId = linkedRequest
      ? linkedRequest.form_id
      : typeof body.applicationTemplateId === "string" ? body.applicationTemplateId : undefined;
    const requestedVersion = Number.isSafeInteger(body.applicationTemplateVersion) ? body.applicationTemplateVersion : undefined;
    const template = await resolveCosignerTemplateForApplication(db, appRow, requestedTemplateId, requestedVersion, {
      anyPublishedVariant: Boolean(linkedRequest),
    });
    if (!template || template.pinMissing || (requestedTemplateId && template.templateId !== requestedTemplateId)) {
      return NextResponse.json({ error: "This co-signer form version is unavailable. Reload the link." }, { status: 409 });
    }
    // Name, phone and email are questions like any other, so a template may no longer ask for them. What the
    // template asks is validated from the body as before. What it does NOT ask is never taken from the body:
    // a signed-in filler (the linked-form path) is recorded from their ACCOUNT. A signed-out co-signer has no
    // account to read, so their name and email stay required either way.
    const nameAsked = isWizardFormFieldEnabled(template.config, "fullLegalName");
    const emailAsked = isWizardFormFieldEnabled(template.config, "email");
    const phoneAsked = isWizardFormFieldEnabled(template.config, "phone");
    let fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    let email = typeof body.email === "string" ? body.email.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (linkedUser && (!nameAsked || !emailAsked)) {
      const account = await loadApplicantAccountIdentity(db, linkedUser);
      if (!nameAsked) fullName = account.name;
      if (!emailAsked) email = account.email;
    }
    // Only what the filler typed is validated; a value read from their account needs no format check.
    const identityError = [
      nameAsked || !linkedUser ? validateFullName(fullName) : { ok: true as const },
      emailAsked || !linkedUser ? validateEmail(email) : { ok: true as const },
      phoneAsked || phone ? validatePhone10(phone) : { ok: true as const },
    ].find((result) => !result.ok);
    if (identityError && !identityError.ok) return NextResponse.json({ error: identityError.message }, { status: 400 });
    const dob = typeof body.dob === "string" ? body.dob.trim() : "";
    const ssn = typeof body.ssn === "string" ? body.ssn.trim() : "";
    const dobEnabled = isWizardFormFieldEnabled(template.config, "dateOfBirth");
    const ssnEnabled = isWizardFormFieldEnabled(template.config, "ssn");
    const dobCheck = dobEnabled && (isWizardFormFieldRequired(template.config, "dateOfBirth") || dob)
      ? validateDateRequired(dob, "Date of birth") : { ok: true as const };
    const ssnCheck = ssnEnabled && (isWizardFormFieldRequired(template.config, "ssn") || ssn)
      ? validateSsn(ssn) : { ok: true as const };
    const builtInError = [dobCheck, ssnCheck].find((result) => !result.ok);
    if (builtInError && !builtInError.ok) return NextResponse.json({ error: builtInError.message }, { status: 400 });
    const questions = listingCustomApplicationFields(template.config);
    if (questions.some((question) => question.type === "file" || question.type === "photos")) {
      return NextResponse.json({ error: "This co-signer form includes an unavailable upload question. Ask the property manager to update the form." }, { status: 409 });
    }
    const submittedAnswers = Array.isArray(body.customFieldAnswers) ? body.customFieldAnswers as RentalCustomFieldAnswer[] : [];
    const answerByKey = new Map(submittedAnswers.filter((answer) => answer && typeof answer.key === "string" && typeof answer.value === "string").map((answer) => [answer.key, answer.value]));
    const answers = questions.map((question) => ({ key: question.key, label: question.label, type: question.type, section: question.section, value: answerByKey.get(question.key) ?? "" }));
    const questionErrors = validateCustomFieldAnswers(questions, answers);
    if (Object.keys(questionErrors).length) return NextResponse.json({ error: "Complete the co-signer form questions.", fields: questionErrors }, { status: 422 });

    // Alias lookup must link to the actual persisted parent primary key.
    const resolvedSignerAppId = String(appRow.id);
    const submission: CosignerSubmission = {
      signerAppId: resolvedSignerAppId,
      signerFullName: String(body.signerFullName ?? "").trim(),
      fullName,
      email: email.toLowerCase(),
      phone,
      dob: dobEnabled ? dob : "",
      dlNumber: String(body.dlNumber ?? "").trim(),
      ssn: ssnEnabled ? ssn : "",
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
      applicationTemplateId: template.templateId,
      applicationTemplateVersion: template.templateVersion,
      customFieldAnswers: answers,
    };

    const id = makeCosignerId();
    const stored = sealCosignerIdentity(stripSensitiveForStorage(submission), id, managerUserId);

    const { error } = await db.from("cosigner_submission_records").insert({
      id,
      signer_app_id: resolvedSignerAppId,
      manager_user_id: managerUserId,
      row_data: stored,
      updated_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (linkedRequest) {
      // Compare-and-swap on the open statuses: if another submit already finished this form, this one is undone.
      const finished = await completeLinkedFormRequest(db, linkedRequest.id, { filledByUserId: linkedUserId, submissionRef: id });
      if (!finished) {
        await db.from("cosigner_submission_records").delete().eq("id", id);
        return NextResponse.json({ error: "This form is already finished." }, { status: 409 });
      }
    } else if (template.templateId) {
      // The legacy public co-signer link: it still finishes the request a co-signer rule opened.
      void completeOpenLinkedFormRequestByForm(db, {
        applicationId: resolvedSignerAppId,
        formKind: "application",
        formId: template.templateId,
        filledByUserId: null,
        submissionRef: id,
      });
    }

    const appData = appRow.row_data as { name?: string; property?: string } | null;
    void notifyManagerCosignerSubmitted({
      managerUserId,
      signerAppId: resolvedSignerAppId,
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
