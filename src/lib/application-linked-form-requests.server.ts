import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { linkedFormSharePath } from "@/lib/linked-form-path";
import {
  evaluateLinkedFormRules,
  LINKED_FORM_LINK_TTL_DAYS,
  type IssuedLinkedFormView,
  type LinkedFormRequestStatus,
  type LinkedFormRequestView,
} from "@/lib/application-linked-form-requests";
import type { LinkedFormRef } from "@/lib/application-linked-forms";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import {
  normalizeCustomApplicationFields,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  applicationFormVariantForTemplate,
  cosignerTemplateIdOwedByApplication,
  readPropertyApplicationTemplates,
} from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { resolveListingApplicationFields } from "@/lib/rental-application/application-field-catalog";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import { openApplicantRow } from "@/lib/security/applicant-identity";

/* ---------------------------------------------------------------- tokens */

const TOKEN_BYTES = 32;

/** The only thing stored about a share link. The token itself is shown once, to whoever minted it. */
export function hashLinkedFormToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/** 32 cryptographically random bytes, URL-safe. */
export function mintLinkedFormToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashLinkedFormToken(token) };
}

function expiryFromNow(): string {
  return new Date(Date.now() + LINKED_FORM_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/* ------------------------------------------------------------------ rows */

export type LinkedFormRequestRow = {
  id: string;
  manager_user_id: string;
  application_id: string;
  applicant_user_id: string | null;
  helper_user_id: string | null;
  rule_id: string;
  form_kind: "application" | "move_in";
  form_id: string;
  source_question_label: string;
  source_answer_label: string;
  needed_before_review: boolean;
  status: LinkedFormRequestStatus;
  filled_by_user_id: string | null;
  completed_submission_ref: string | null;
  completed_at: string | null;
  fee_cents: number | null;
  fee_session_id: string | null;
  fee_paid_at: string | null;
  fee_paid_by_user_id: string | null;
  expires_at: string;
};

/** Never selects `token_hash`: nothing but the redeem lookup needs it, and that filters on it. */
export const LINKED_FORM_REQUEST_COLUMNS =
  "id, manager_user_id, application_id, applicant_user_id, helper_user_id, rule_id, form_kind, form_id, source_question_label, source_answer_label, needed_before_review, status, filled_by_user_id, completed_submission_ref, completed_at, fee_cents, fee_session_id, fee_paid_at, fee_paid_by_user_id, expires_at";

/* -------------------------------------------------------- form lookups */

export type DescribedLinkedForm = { label: string; questionCount: number | null };

/** The form's name and question count, read from the property's own stored forms. Null when the form is gone. */
export function describeLinkedForm(
  listing: ManagerListingSubmissionV1 | null | undefined,
  ref: LinkedFormRef,
): DescribedLinkedForm | null {
  if (!listing) return null;
  if (ref.kind === "move_in") {
    const template = readMoveInFormTemplates(listing).find((candidate) => candidate.id === ref.id);
    if (!template) return null;
    return { label: template.name.trim() || "Move-in form", questionCount: template.questions.length };
  }
  const template = readPropertyApplicationTemplates(listing).find((candidate) => candidate.id === ref.id);
  if (!template) return null;
  const resolved = applicationConfigForApplicant(listing, applicationFormVariantForTemplate(template), template.id);
  const questions = resolveListingApplicationFields(resolved.config, normalizeCustomApplicationFields);
  return {
    label: template.label.trim() || "Application",
    questionCount: resolved.pinMissing ? null : questions.length,
  };
}

async function loadPropertyListing(
  db: SupabaseClient,
  propertyId: string,
): Promise<{ ownerUserId: string; listing: ManagerListingSubmissionV1 | null } | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data } = await db
    .from("manager_property_records")
    .select("property_data, manager_user_id")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const ownerUserId = String(data.manager_user_id ?? "").trim();
  if (!ownerUserId) return null;
  const submission = (data.property_data as { listingSubmission?: unknown } | null)?.listingSubmission;
  const listing =
    submission && typeof submission === "object" && (submission as { v?: unknown }).v === 1
      ? normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1)
      : null;
  return { ownerUserId, listing };
}

function propertyIdOfRow(row: Pick<DemoApplicantRow, "assignedPropertyId" | "propertyId" | "application">): string {
  return (
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    (row.application as { propertyId?: string } | undefined)?.propertyId?.trim() ||
    ""
  );
}

/* --------------------------------------------------------- on submit */

/** `shareToken` is shown once, to the browser that just submitted. Only its hash is stored. */
export type IssuedLinkedForm = IssuedLinkedFormView;

/**
 * On application submit: evaluate the published template's rules against the answers and write one
 * request per matched form. Deduped per form (`application_id, form_kind, form_id` is unique), so a
 * re-submit never doubles the list and returns only the requests it just created.
 *
 * Never throws into the caller: a form that cannot be recorded must not fail the application.
 */
export async function createLinkedFormRequestsForSubmit(
  db: SupabaseClient,
  input: { applicationId: string; row: DemoApplicantRow },
): Promise<IssuedLinkedForm[]> {
  try {
    const { row } = input;
    const application = row.application as unknown as ({ customFieldAnswers?: never[] } & Record<string, unknown>) | undefined;
    if (!application) return [];
    const propertyId = propertyIdOfRow(row);
    const property = await loadPropertyListing(db, propertyId);
    if (!property?.listing) return [];
    const { listing, ownerUserId } = property;

    const pinnedTemplateId = String((application as { applicationTemplateId?: string }).applicationTemplateId ?? "").trim();
    const templates = readPropertyApplicationTemplates(listing);
    const pinnedTemplate = pinnedTemplateId ? templates.find((candidate) => candidate.id === pinnedTemplateId) : undefined;
    const variant = pinnedTemplate ? applicationFormVariantForTemplate(pinnedTemplate) : "standard";
    const resolved = applicationConfigForApplicant(
      listing,
      variant,
      pinnedTemplateId || undefined,
      (application as { applicationTemplateVersion?: number }).applicationTemplateVersion,
    );
    // An application that never recorded which form it used (a draft saved before the wizard pinned one) was
    // asked the form the listing resolves for it, so that form's own co-signer link and rules still apply.
    const templateId = pinnedTemplateId || resolved.templateId || "";
    const template = pinnedTemplate ?? (templateId ? templates.find((candidate) => candidate.id === templateId) : undefined);
    const questions = resolveListingApplicationFields(resolved.config, normalizeCustomApplicationFields);
    const matches = evaluateLinkedFormRules({
      questions,
      application,
      // Co-signer is long term only: a short-term applicant never owes the derived co-signer form.
      linkedCosignerApplicationTemplateId: cosignerTemplateIdOwedByApplication(template, listing, readPropertyLeaseTemplates(listing)),
    }).filter((match) => !(match.rule.formRef.kind === "application" && match.rule.formRef.id === templateId));
    if (matches.length === 0) return [];

    const applicantUserId = row.residentUserId?.trim() || null;
    const leaseTerm = String((application as { leaseTerm?: string }).leaseTerm ?? "").trim() || undefined;
    const prepared: Array<{ insert: Record<string, unknown>; token: string; view: Omit<LinkedFormRequestView, "id"> }> = [];
    for (const match of matches) {
      const described = describeLinkedForm(listing, match.rule.formRef);
      if (!described) continue; // a rule that points at a form since deleted owes nothing
      let feeCents: number | null = null;
      if (match.rule.formRef.kind === "application") {
        // The fee is a display fact: a form that owes must still be recorded when pricing cannot be read.
        try {
          const fee = await resolveApplicationFeeProperty(
            db,
            { propertyId, managerUserId: ownerUserId, leaseTerm, applicationTemplateId: match.rule.formRef.id },
            { allowZeroFee: true },
          );
          feeCents = fee.ok ? fee.value.applicationFeeCents : null;
        } catch (cause) {
          console.error("[linked-forms] could not resolve a linked form fee", cause instanceof Error ? cause.message : "unknown");
        }
      }
      const { token, tokenHash } = mintLinkedFormToken();
      const expiresAt = expiryFromNow();
      prepared.push({
        token,
        insert: {
          manager_user_id: ownerUserId,
          application_id: input.applicationId,
          applicant_user_id: applicantUserId,
          rule_id: match.rule.id,
          form_kind: match.rule.formRef.kind,
          form_id: match.rule.formRef.id,
          source_question_label: match.questionLabel.slice(0, 300),
          source_answer_label: match.answerLabel.slice(0, 300),
          needed_before_review: match.rule.neededBeforeReview,
          token_hash: tokenHash,
          status: "owed",
          fee_cents: feeCents,
          expires_at: expiresAt,
        },
        view: {
          applicationId: input.applicationId,
          ruleId: match.rule.id,
          formKind: match.rule.formRef.kind,
          formId: match.rule.formRef.id,
          formLabel: described.label,
          questionCount: described.questionCount,
          sourceQuestionLabel: match.questionLabel,
          sourceAnswerLabel: match.answerLabel,
          neededBeforeReview: match.rule.neededBeforeReview,
          status: "owed",
          feeCents,
          feePaid: false,
          completedAt: null,
          applicantName: row.name?.trim() || null,
          viewerRole: "applicant",
          expiresAt,
        },
      });
    }
    if (prepared.length === 0) return [];

    const { data, error } = await db
      .from("application_form_requests")
      .upsert(
        prepared.map((entry) => entry.insert),
        { onConflict: "application_id,form_kind,form_id", ignoreDuplicates: true },
      )
      .select("id, form_kind, form_id");
    if (error) {
      console.error("[linked-forms] could not record requests", error.message);
      return [];
    }
    const created = new Map(
      ((data ?? []) as Array<{ id: string; form_kind: string; form_id: string }>).map((entry) => [
        `${entry.form_kind}:${entry.form_id}`,
        entry.id,
      ]),
    );
    const issued: IssuedLinkedForm[] = [];
    for (const entry of prepared) {
      const id = created.get(`${entry.view.formKind}:${entry.view.formId}`);
      if (!id) continue; // already existed: its token was shown when it was created
      issued.push({ ...entry.view, id, shareToken: entry.token, sharePath: linkedFormSharePath(entry.token) });
    }
    return issued;
  } catch (error) {
    console.error("[linked-forms] create failed", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

/* ------------------------------------------------------------- access */

export type ViewerRole = "applicant" | "helper" | "manager";

export type ApplicationAccessRow = {
  id: string;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  resident_email: string | null;
  row_data: unknown;
};

const APPLICATION_ACCESS_COLUMNS = "id, manager_user_id, property_id, assigned_property_id, resident_email, row_data";

function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export async function loadApplicationAccessRow(db: SupabaseClient, applicationId: string): Promise<ApplicationAccessRow | null> {
  const trimmed = applicationId.trim();
  if (!trimmed) return null;
  const variants = [...new Set([trimmed, normalizeApplicationAxisId(trimmed), normalizeApplicationAxisId(trimmed).toUpperCase()].filter(Boolean))];
  const { data } = await db.from("manager_application_records").select(APPLICATION_ACCESS_COLUMNS).in("id", variants).limit(1);
  return ((data ?? [])[0] as ApplicationAccessRow | undefined) ?? null;
}

/** The applicant's own row: a signed-in email that matches (never an empty one), and a bound user id must agree. */
export function userOwnsApplication(
  app: Pick<ApplicationAccessRow, "id" | "resident_email" | "row_data">,
  user: { id: string; email?: string | null },
  request?: Pick<LinkedFormRequestRow, "applicant_user_id"> | null,
): boolean {
  if (request?.applicant_user_id && request.applicant_user_id === user.id) return true;
  const row = openApplicantRow(app.row_data, app.id, true, { soft: true });
  const bound = row.residentUserId?.trim();
  if (bound && bound !== user.id) return false;
  const sessionEmail = normalizeEmail(user.email);
  if (!sessionEmail) return false;
  return sessionEmail === normalizeEmail(row.email) || sessionEmail === normalizeEmail(app.resident_email);
}

/**
 * What the signed-in caller is to this request, re-derived from the database: the manager of the
 * application, its applicant, or a helper linked through a share link. Null means no access, and the
 * caller must answer exactly as it would for a request that does not exist.
 */
export async function resolveLinkedFormViewerRole(
  db: SupabaseClient,
  request: LinkedFormRequestRow,
  user: { id: string; email?: string | null },
): Promise<{ role: ViewerRole; app: ApplicationAccessRow } | null> {
  const app = await loadApplicationAccessRow(db, request.application_id);
  if (!app) return null;
  if (await managerCanAccessApplicationRecord(db, user.id, app)) return { role: "manager", app };
  if (userOwnsApplication(app, user, request)) return { role: "applicant", app };
  // Single request scope: only the one person who opened THIS request's link, never the applicant's other forms.
  if (request.helper_user_id && request.helper_user_id === user.id) return { role: "helper", app };
  return null;
}

export async function loadLinkedFormRequest(db: SupabaseClient, requestId: string): Promise<LinkedFormRequestRow | null> {
  const id = requestId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("application_form_requests").select(LINKED_FORM_REQUEST_COLUMNS).eq("id", id).maybeSingle();
  return (data as LinkedFormRequestRow | null) ?? null;
}

/* ---------------------------------------------------------------- views */

type ViewContext = { viewerRole: ViewerRole; app: ApplicationAccessRow };

export async function toLinkedFormRequestViews(
  db: SupabaseClient,
  entries: Array<{ request: LinkedFormRequestRow } & ViewContext>,
): Promise<LinkedFormRequestView[]> {
  const listings = new Map<string, ManagerListingSubmissionV1 | null>();
  const out: LinkedFormRequestView[] = [];
  for (const { request, viewerRole, app } of entries) {
    const row = openApplicantRow(app.row_data, app.id, true, { soft: true });
    const propertyId = propertyIdOfRow(row) || String(app.assigned_property_id ?? app.property_id ?? "").trim();
    if (!listings.has(propertyId)) listings.set(propertyId, (await loadPropertyListing(db, propertyId))?.listing ?? null);
    const described = describeLinkedForm(listings.get(propertyId), { kind: request.form_kind, id: request.form_id });
    out.push({
      id: request.id,
      applicationId: request.application_id,
      ruleId: request.rule_id,
      formKind: request.form_kind,
      formId: request.form_id,
      formLabel: described?.label ?? (request.form_kind === "move_in" ? "Move-in form" : "Form"),
      questionCount: described?.questionCount ?? null,
      sourceQuestionLabel: request.source_question_label,
      sourceAnswerLabel: request.source_answer_label,
      neededBeforeReview: request.needed_before_review,
      status: request.status,
      feeCents: request.fee_cents,
      feePaid: Boolean(request.fee_paid_at),
      completedAt: request.completed_at,
      applicantName: row.name?.trim() || null,
      viewerRole,
      expiresAt: request.expires_at,
    });
  }
  return out;
}

/** The manager's list for one application. Caller has already proven manager access. */
export async function listLinkedFormRequestsForApplication(
  db: SupabaseClient,
  app: ApplicationAccessRow,
  viewerRole: ViewerRole,
): Promise<LinkedFormRequestView[]> {
  const { data } = await db
    .from("application_form_requests")
    .select(LINKED_FORM_REQUEST_COLUMNS)
    .eq("application_id", app.id)
    .order("created_at", { ascending: true });
  const requests = (data ?? []) as LinkedFormRequestRow[];
  return toLinkedFormRequestViews(db, requests.map((request) => ({ request, viewerRole, app })));
}

/** Everything the signed-in resident owes or helps with: their own forms, and those they were linked to. */
export async function listLinkedFormRequestsForResident(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
): Promise<{ own: LinkedFormRequestView[]; helping: LinkedFormRequestView[] }> {
  const sessionEmail = normalizeEmail(user.email);
  const appIds = new Set<string>();
  const { data: byUser } = await db.from("application_form_requests").select("application_id").eq("applicant_user_id", user.id);
  for (const entry of (byUser ?? []) as Array<{ application_id: string }>) appIds.add(entry.application_id);
  if (sessionEmail) {
    const { data: byEmail } = await db.from("manager_application_records").select("id").eq("resident_email", sessionEmail).limit(100);
    for (const entry of (byEmail ?? []) as Array<{ id: string }>) appIds.add(entry.id);
  }
  const own: LinkedFormRequestView[] = [];
  if (appIds.size > 0) {
    const { data: ownRows } = await db
      .from("application_form_requests")
      .select(LINKED_FORM_REQUEST_COLUMNS)
      .in("application_id", [...appIds])
      .order("created_at", { ascending: true });
    const apps = new Map<string, ApplicationAccessRow>();
    for (const request of (ownRows ?? []) as LinkedFormRequestRow[]) {
      let app = apps.get(request.application_id);
      if (!app) {
        app = (await loadApplicationAccessRow(db, request.application_id)) ?? undefined;
        if (app) apps.set(request.application_id, app);
      }
      if (!app || !userOwnsApplication(app, user, request)) continue;
      own.push(...(await toLinkedFormRequestViews(db, [{ request, viewerRole: "applicant", app }])));
    }
  }
  const helping: LinkedFormRequestView[] = [];
  const { data: helpRows } = await db
    .from("application_form_requests")
    .select(LINKED_FORM_REQUEST_COLUMNS)
    .eq("helper_user_id", user.id)
    .order("created_at", { ascending: true });
  for (const request of (helpRows ?? []) as LinkedFormRequestRow[]) {
    const app = await loadApplicationAccessRow(db, request.application_id);
    if (!app) continue;
    helping.push(...(await toLinkedFormRequestViews(db, [{ request, viewerRole: "helper", app }])));
  }
  return { own, helping };
}

/* ----------------------------------------------------------- the link */

/**
 * Mints a fresh token for one request and stores only its hash. The previous link stops working, so a
 * manager or applicant who asks for "the link" again always gets one that works. A finished or waived
 * request has no link to give.
 *
 * `revokeHelper` is the explicit "new link": only then does whoever already opened the link lose
 * access. Showing the link again is NOT that - a helper part-way through the form would be cut off
 * (`resolveLinkedFormViewerRole` stops recognising them and their submit 404s), so the ordinary
 * re-share keeps `helper_user_id` exactly as it is.
 */
export async function rotateLinkedFormToken(
  db: SupabaseClient,
  request: LinkedFormRequestRow,
  opts: { revokeHelper?: boolean } = {},
): Promise<{ token: string; path: string } | null> {
  if (request.status !== "owed" && request.status !== "shared") return null;
  const { token, tokenHash } = mintLinkedFormToken();
  const { error } = await db
    .from("application_form_requests")
    .update({
      token_hash: tokenHash,
      status: "shared",
      ...(opts.revokeHelper ? { helper_user_id: null } : {}),
      expires_at: expiryFromNow(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .in("status", ["owed", "shared"]);
  if (error) return null;
  return { token, path: linkedFormSharePath(token) };
}

/** A token that cannot be used says nothing about why. Callers answer every refusal the same way. */
export type RedeemResult =
  | { ok: true; request: LinkedFormRequestRow; role: "applicant" | "helper" }
  | { ok: false };

export async function redeemLinkedFormToken(
  db: SupabaseClient,
  token: string,
  user: { id: string; email?: string | null },
): Promise<RedeemResult> {
  const trimmed = token.trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(trimmed)) return { ok: false };
  const { data } = await db
    .from("application_form_requests")
    .select(LINKED_FORM_REQUEST_COLUMNS)
    .eq("token_hash", hashLinkedFormToken(trimmed))
    .maybeSingle();
  const request = (data as LinkedFormRequestRow | null) ?? null;
  if (!request) return { ok: false };
  if (request.status !== "owed" && request.status !== "shared") return { ok: false };
  if (new Date(request.expires_at).getTime() <= Date.now()) return { ok: false };
  const app = await loadApplicationAccessRow(db, request.application_id);
  if (!app) return { ok: false };

  if (userOwnsApplication(app, user, request)) {
    return { ok: true, request, role: "applicant" };
  }
  // A manager opening their own applicant's link is not a helper; refuse rather than link them.
  if (await managerCanAccessApplicationRecord(db, user.id, app)) return { ok: false };

  // Single use per hand-off: once one person has opened the link, a second person is refused like any bad link.
  if (request.helper_user_id && request.helper_user_id !== user.id) return { ok: false };
  const { data: claimed, error: claimError } = await db
    .from("application_form_requests")
    .update({ helper_user_id: user.id, updated_at: new Date().toISOString() })
    .eq("id", request.id)
    .in("status", ["owed", "shared"])
    .or(`helper_user_id.is.null,helper_user_id.eq.${user.id}`)
    .select("id");
  if (claimError || !Array.isArray(claimed) || claimed.length === 0) return { ok: false };

  const applicantUserId = request.applicant_user_id ?? (await applicantUserIdFor(db, app));
  if (applicantUserId && applicantUserId !== user.id) {
    // The applicant <-> helper link behind "Forms for <applicant>". One row per pair per application.
    await db.from("resident_account_links").upsert(
      {
        application_id: request.application_id,
        applicant_user_id: applicantUserId,
        helper_user_id: user.id,
        form_request_id: request.id,
      },
      { onConflict: "applicant_user_id,helper_user_id,application_id", ignoreDuplicates: true },
    );
  }
  // With no applicant login yet there is nobody to link to; the helper still holds THIS request.
  return { ok: true, request: { ...request, helper_user_id: user.id }, role: "helper" };
}

async function applicantUserIdFor(db: SupabaseClient, app: ApplicationAccessRow): Promise<string | null> {
  const row = openApplicantRow(app.row_data, app.id, true, { soft: true });
  const bound = row.residentUserId?.trim();
  if (bound) return bound;
  const email = normalizeEmail(row.email) || normalizeEmail(app.resident_email);
  if (!email) return null;
  const { data } = await db.from("profiles").select("id").ilike("email", email.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
  const id = typeof (data as { id?: unknown } | null)?.id === "string" ? (data as { id: string }).id : "";
  return id || null;
}

/* ------------------------------------------------------------- finish */

/**
 * Marks a request done. A compare-and-swap on the open statuses, so two fills never both win, and only
 * ever the person who actually submitted is recorded.
 */
export async function completeLinkedFormRequest(
  db: SupabaseClient,
  requestId: string,
  input: { filledByUserId: string | null; submissionRef: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("application_form_requests")
    .update({
      status: "done",
      filled_by_user_id: input.filledByUserId,
      completed_submission_ref: input.submissionRef.slice(0, 200),
      completed_at: now,
      updated_at: now,
    })
    .eq("id", requestId)
    .in("status", ["owed", "shared"])
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * Best-effort hook for forms that arrive through their own existing path (the applicant's move-in form
 * submit, the legacy public co-signer link): that form was what a request was waiting on, so it is done.
 * A submission with no signed-in person records no `filled_by_user_id`.
 */
export async function completeOpenLinkedFormRequestByForm(
  db: SupabaseClient,
  input: {
    applicationId: string;
    formKind: "application" | "move_in";
    formId: string;
    filledByUserId: string | null;
    submissionRef: string;
  },
): Promise<void> {
  try {
    const { data } = await db
      .from("application_form_requests")
      .select("id")
      .eq("application_id", input.applicationId)
      .eq("form_kind", input.formKind)
      .eq("form_id", input.formId)
      .in("status", ["owed", "shared"])
      .maybeSingle();
    const id = typeof (data as { id?: unknown } | null)?.id === "string" ? (data as { id: string }).id : "";
    if (id) await completeLinkedFormRequest(db, id, { filledByUserId: input.filledByUserId, submissionRef: input.submissionRef });
  } catch {
    // Best-effort: a missed hook leaves the row owed, which the manager can mark done.
  }
}

export async function markLinkedFormNotNeeded(db: SupabaseClient, requestId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("application_form_requests")
    .update({ status: "not_needed", updated_at: now })
    .eq("id", requestId)
    .in("status", ["owed", "shared"])
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}
