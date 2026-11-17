import type { DemoApplicantRow } from "@/data/demo-portal";
import { isPlaceholderApplicantName } from "@/lib/rental-application/applicant-name";

/**
 * Who an application is FROM, when the template no longer asks.
 *
 * Every question is removable (captain, Oct 5 2026), including "Full legal name" and "Email". A
 * template without them still has to record WHO applied, because the resident row, the lease, screening
 * and approval all read a name and an email. Those come from the applicant's SIGNED-IN ACCOUNT, never
 * from the request body (AGENTS.md: ids and identity in a body are not authorization).
 *
 * This file is pure (no I/O) so the route, the fee-promotion path and the tests share one decision. The
 * database half — reading the viewer's profile — is `applicant-identity.server.ts`.
 */

export type ApplicantAuthUser = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type ApplicantProfileIdentity = {
  email?: string | null;
  full_name?: string | null;
};

export type ApplicantIdentityAnswers = {
  fullLegalName?: unknown;
  email?: unknown;
};

export type ApplicantIdentity = {
  /** Never empty when the account has any email: answer, else profile, else auth metadata, else the email's local part. */
  name: string;
  /** Lower-cased. The ACCOUNT's email whenever one exists; the answer's only for a signed-out applicant. */
  email: string;
  nameSource: "answer" | "profile" | "metadata" | "email" | "none";
  emailSource: "account" | "answer" | "none";
  /** True when an answered email differs from the account's. The answer never wins; the caller decides whether to refuse. */
  emailMismatch: boolean;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function metadataName(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return "";
  const full = clean(meta.full_name) || clean(meta.name);
  if (full) return full;
  return [clean(meta.given_name) || clean(meta.first_name), clean(meta.family_name) || clean(meta.last_name)]
    .filter(Boolean)
    .join(" ");
}

function localPart(email: string): string {
  const at = email.indexOf("@");
  return (at > 0 ? email.slice(0, at) : "").trim();
}

/**
 * The applicant's name and email.
 *
 * Email: the authenticated account's email is authoritative whenever the applicant is signed in; a body
 * answer fills in only when there is no account email at all (a guest), and a differing answer is reported
 * as `emailMismatch` rather than honoured. Name: the answer, else the profile's full name, else the auth
 * metadata's `full_name` / `name`, else the email's local part. A placeholder answer ("Applicant", "n/a")
 * is treated as missing.
 */
export function resolveApplicantIdentity(input: {
  answers?: ApplicantIdentityAnswers | null;
  authUser?: ApplicantAuthUser | null;
  profile?: ApplicantProfileIdentity | null;
}): ApplicantIdentity {
  const answerEmail = clean(input.answers?.email).toLowerCase();
  const accountEmail = (clean(input.authUser?.email) || clean(input.profile?.email)).toLowerCase();
  const email = accountEmail || answerEmail;
  const emailSource: ApplicantIdentity["emailSource"] = accountEmail ? "account" : answerEmail ? "answer" : "none";
  const emailMismatch = Boolean(accountEmail && answerEmail && accountEmail !== answerEmail);

  const answerName = clean(input.answers?.fullLegalName);
  const profileName = clean(input.profile?.full_name);
  const metaName = metadataName(input.authUser?.user_metadata);
  const fallbackName = localPart(email);
  const candidates: Array<[ApplicantIdentity["nameSource"], string]> = [
    ["answer", answerName],
    ["profile", profileName],
    ["metadata", metaName],
    ["email", fallbackName],
  ];
  const hit = candidates.find(([, value]) => value && !isPlaceholderApplicantName(value));
  return {
    name: hit ? hit[1] : "",
    email,
    nameSource: hit ? hit[0] : "none",
    emailSource,
    emailMismatch,
  };
}

/** The wizard-built row an applicant writes for themselves (never a manager's manual add). */
export function isApplicantWizardRow(row: DemoApplicantRow): boolean {
  return (
    row.bucket === "pending" &&
    row.manuallyAdded !== true &&
    Boolean(row.application) &&
    typeof row.application === "object"
  );
}

/** True when the row lacks a stored identity value the account could supply. */
export function applicantIdentityMissing(row: DemoApplicantRow, opts: { submitted: boolean }): boolean {
  if (!clean(row.email)) return true;
  if (!opts.submitted) return false;
  return (
    isPlaceholderApplicantName(row.name) ||
    isPlaceholderApplicantName(row.application?.fullLegalName) ||
    !clean(row.application?.email)
  );
}

/**
 * Fill ONLY what is empty on the row from the resolved account identity; a value the applicant answered is
 * never replaced (so a template that still asks is byte-identical).
 *
 * - `submitted: false` (a draft autosave) fills only the row-level `email`, which is what the write
 *   authorization and the `resident_email` column key on. It leaves the name and the answers alone: a
 *   draft the wizard resumes must not carry a value the template no longer lets the applicant hold.
 * - `submitted: true` also fills `name`, `application.fullLegalName` and `application.email`, so the lease,
 *   screening, approval and every list read the stored values and never need the answer's field id. Call it
 *   AFTER the answers were validated: a removed question's answer is rejected as a body-supplied value.
 */
export function applyApplicantIdentityToRow(
  row: DemoApplicantRow,
  identity: ApplicantIdentity,
  opts: { submitted: boolean },
): DemoApplicantRow {
  if (!applicantIdentityMissing(row, opts)) return row;
  const email = clean(row.email).toLowerCase() || identity.email;
  const next: DemoApplicantRow = { ...row, ...(email ? { email } : {}) };
  if (!opts.submitted) return next;
  const name = isPlaceholderApplicantName(row.name)
    ? isPlaceholderApplicantName(row.application?.fullLegalName)
      ? identity.name
      : clean(row.application?.fullLegalName)
    : clean(row.name);
  if (name) next.name = name;
  if (row.application) {
    next.application = {
      ...row.application,
      ...(isPlaceholderApplicantName(row.application.fullLegalName) && name ? { fullLegalName: name } : {}),
      ...(!clean(row.application.email) && email ? { email } : {}),
    };
  }
  return next;
}
