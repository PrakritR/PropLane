/**
 * Unified manager / admin / resident lease workflow backed by Supabase records.
 * Buckets match UI tabs: manager → admin → resident → signed.
 * Signing order: manager prepares/sends → resident signs → manager countersigns → fully signed.
 */

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { type DemoApplicantRow, type ManagerLeaseBucket, type ManagerLeaseTab } from "@/data/demo-portal";
import {
  buildAiGeneratedLeaseHtml,
  leaseContextFromApplication,
  leaseTemplateDocForContext,
  leaseTemplateVersionForContext,
} from "@/lib/generated-lease";
import {
  LEASE_ESIGN_CONSENT_TEXT,
  LEASE_ESIGN_CONSENT_VERSION,
  asDocumentSha256,
  documentFingerprintLabel,
  leaseAllowsManagerDocumentEdits,
  leaseDocumentSha256,
  replacesSignedLeaseDocument,
  rowHasAnySignature,
  signedDocumentHashesDiverge,
} from "@/lib/lease-execution-evidence";
import { parseLeaseHtmlSections, rebuildLeaseHtmlFromSections } from "@/lib/lease-html-sections";
import {
  isEditableLeaseSection,
  renderLeaseSectionEdit,
  type LeaseSectionEdit,
} from "@/lib/lease-section-text";
import { appendLeaseTermsRiderToPdf, mergeUploadedLeasePdfWithSignatures } from "@/lib/lease-pdf-signing";
import { leaseTemplateObjectPath, legacyLeaseTemplateObjectPath } from "@/lib/lease-template-storage";
import {
  downloadDataUrl,
  downloadTextContent,
  leaseDownloadBaseName,
  portalDownloadToastMessage,
  type PortalDownloadResult,
} from "@/lib/portal-document-download";
import { stripLeaseAiDisclaimerFromHtml, stripLeaseAiReviewDisclaimer } from "@/lib/lease-templates/types";
import { effectiveApplicationForRow, enrichApplicationForLease, readManagerApplicationRows, signedRentLabelForRow, writeManagerApplicationRows } from "@/lib/manager-applications-storage";
import { getPropertyById, getRoomChoiceLabel, getBundleChoiceLabel } from "@/lib/rental-application/data";
import { cachedLandlordLegalName } from "@/lib/manager-landlord-profile";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { submissionWithLeaseTemplateById } from "@/lib/property-lease-template-sync";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { clearUploadedOwnLease } from "@/lib/resident-lease-upload";
import { applicationVisibleToPortalUser, leaseVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";
import {
  confirmedUploadedLeaseReview,
  normalizeUploadedLeaseParse,
  pendingUploadedLeaseParse,
  unreadUploadedLeaseParse,
  uploadedLeaseNeedsManagerConfirmation,
  type UploadedLeaseFieldKey,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";
import {
  LEASE_DOCUMENT_MISMATCH_MESSAGE,
  LEASE_DOCUMENT_MISMATCH_RECORD_CHANGED_MESSAGE,
  describeLeaseDocumentMismatches,
  leaseDocumentMismatches,
  leaseMismatchAcknowledgementGap,
  leaseRecordFingerprint,
  type LeaseAcknowledgementGap,
  type LeaseDocumentMismatch,
  type LeaseRecordTerms,
} from "@/lib/lease-document-mismatch";
import {
  buildBundleApplicationGroups,
  bundleGroupKey,
  bundleGroupReadyForJointLease,
  bundleIdForApplication,
  isBundleGroupApplication,
  jointLeaseRowId,
  type BundleGroupRowInput,
} from "@/lib/bundle-group/bundle-group-application";
import { applyLeaseBillingToContext } from "@/lib/lease-billing-snapshot";
import { notePortalResponse, portalSessionEnded } from "@/lib/auth/portal-session-gate";
import { buildJointLeaseMembers, buildJointLeasePipelineRow, jointLeaseRowIncludesMember } from "@/lib/bundle-group/joint-lease";
import type { JointLeaseMember, LeaseKind } from "@/lib/bundle-group/types";

export const LEASE_PIPELINE_EVENT = "axis:lease-pipeline";
const LEASE_PIPELINE_SESSION_KEY_PREFIX = "axis:lease-pipeline:v2";
const LEASE_PIPELINE_SUPPRESSED_KEY_PREFIX = "axis:lease-pipeline-suppressed:v1";

let memoryRows: LeasePipelineRow[] = [];
let suppressedLeaseKeys: Set<string> = new Set();
let activeLeasePipelineScopeUserId: string | undefined;
const LEASE_PIPELINE_SYNC_TTL_MS = 15_000;
let leasePipelineLastSyncedAt = 0;
let leasePipelineSyncPromise: Promise<LeasePipelineRow[]> | null = null;

function leaseRowsChanged(a: LeasePipelineRow[], b: LeasePipelineRow[]) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A consent version is an attestation, so only a version we can quote back counts. */
function asConsentVersion(value: unknown): string | null {
  return value === LEASE_ESIGN_CONSENT_VERSION ? LEASE_ESIGN_CONSENT_VERSION : null;
}

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeLeaseSignature(raw: unknown, role: "manager" | "resident"): LeaseSignature | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<LeaseSignature>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const signedAtIso = typeof r.signedAtIso === "string" ? r.signedAtIso.trim() : "";
  if (!name || !signedAtIso) return null;
  return {
    name,
    signedAtIso,
    role,
    documentSha256: asDocumentSha256(r.documentSha256),
    consentVersion: optionalTrimmedString(r.consentVersion),
  };
}

function signatureDateLabel(iso: string | undefined | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function electronicSignatureBlock(row: LeasePipelineRow): string {
  const manager = row.managerSignature ?? null;
  const resident = row.residentSignature ?? normalizeLeaseSignature(
    row.signatureName && row.signedAtIso
      ? { name: row.signatureName, signedAtIso: row.signedAtIso, role: "resident" }
      : null,
    "resident",
  );
  if (!manager && !resident) return "";
  const signatureCard = (label: string, sig: LeaseSignature | null) => {
    const fingerprint = documentFingerprintLabel(sig?.documentSha256);
    return `
    <div class="axis-esign-card">
      <p class="axis-esign-label">${escapeHtml(label)}</p>
      ${
        sig
          ? `<p class="axis-esign-name">${escapeHtml(sig.name)}</p><p class="axis-esign-meta">Electronically signed ${escapeHtml(signatureDateLabel(sig.signedAtIso))}</p>` +
            (fingerprint
              ? `<p class="axis-esign-meta">Document signed (fingerprint begins) <span class="axis-esign-mono">${escapeHtml(fingerprint)}</span></p>`
              : "") +
            // Only a version we can actually quote back counts as an
            // attestation; an unrecognized string asserts nothing.
            (sig.consentVersion === LEASE_ESIGN_CONSENT_VERSION
              ? `<p class="axis-esign-meta">Consented to transact electronically</p>`
              : "")
          : `<p class="axis-esign-pending">Pending signature</p>`
      }
    </div>`;
  };

  const provenance = [
    // The FULL digest, not the readable prefix. A 64-bit prefix is a
    // convenience for a human comparing two certificates; it is not enough to
    // stand behind in a dispute, and the counterparty has no other copy.
    row.documentSha256
      ? `<li>Document fingerprint (SHA-256): <span class="axis-esign-mono">${escapeHtml(row.documentSha256)}</span></li>`
      : "",
    row.templateVersion ? `<li>Lease template: ${escapeHtml(row.templateVersion)}</li>` : "",
    row.executedJurisdiction ? `<li>Executed under: ${escapeHtml(row.executedJurisdiction)}</li>` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  const consentQuote =
    manager?.consentVersion === LEASE_ESIGN_CONSENT_VERSION || resident?.consentVersion === LEASE_ESIGN_CONSENT_VERSION
      ? `<p class="axis-esign-fine">Consent accepted before signing: &ldquo;${escapeHtml(LEASE_ESIGN_CONSENT_TEXT)}&rdquo;</p>`
      : "";

  const divergence = signedDocumentHashesDiverge(row)
    ? `<p class="axis-esign-warn">The two parties did not sign identical documents. Each fingerprint above identifies the document that party actually signed.</p>`
    : "";

  return `
<!-- axis-signatures:start -->
<section class="axis-esign">
  <h2>Electronic Signature Certificate</h2>
  <p>This lease requires exactly two electronic signatures—one from the landlord / authorized agent and one from the resident / tenant. This certificate is the binding record for both. Each typed name below was accepted in the PropLane portal as that party&apos;s electronic signature.</p>
  <div class="axis-esign-grid">
    ${signatureCard("Landlord / Authorized Agent", manager)}
    ${signatureCard("Resident / Tenant", resident)}
  </div>
  ${divergence}
  ${
    provenance
      ? `<ul class="axis-esign-provenance">
    ${provenance}
  </ul>
  <p class="axis-esign-fine">The fingerprint is a SHA-256 checksum of this lease document exactly as it was presented for signature (it does not cover this certificate). Any later change to the document, however small, produces a different fingerprint.</p>`
      : ""
  }
  ${consentQuote}
</section>
<!-- axis-signatures:end -->`;
}

export function hasAnyLeaseSignature(row: LeasePipelineRow): boolean {
  // One definition, shared with the server-side guard, so the client and the
  // route can never disagree about what counts as a signed row.
  return rowHasAnySignature(row);
}

/** True when the manager may generate, upload, or replace the lease document (manager review only). */
export { leaseAllowsManagerDocumentEdits } from "@/lib/lease-execution-evidence";

/**
 * True when an uploaded lease has not been confirmed by a human, so it must not
 * become signable.
 *
 * Machine extraction of a contract promoted straight to a signable document is
 * how someone ends up signing terms nobody checked — and an upload nobody read
 * at all is the same hazard with less evidence, not less of it. This used to be
 * scoped to rows that carried a parse, which exempted every legacy and seeded
 * upload: "Send → preview → Send lease & notification" released those with no
 * review step, no attestation, and no confirmation of the document's terms.
 * `normalizeLeasePipelineRow` now gives an unread upload an explicit
 * `unreadUploadedLeaseParse`, so this one predicate covers both.
 *
 * An off-platform `externallySignedLease` filing, and any row already carrying
 * a signature, are still untouched — normalize leaves those without a parse,
 * because a filing is evidence of an executed lease rather than a document
 * waiting to be sent.
 */
export function leaseAwaitsUploadedLeaseReview(row: LeasePipelineRow): boolean {
  return uploadedLeaseNeedsManagerConfirmation(row.uploadedLeaseParse);
}

export const UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE =
  "Review the imported lease and confirm it before sending it for signature.";

/**
 * Terms the uploaded document states that disagree with this lease record.
 *
 * The record side comes from the row the manager is looking at, so this is
 * literally "does the PDF on this page describe the tenancy this page is
 * about". See `lease-document-mismatch.ts` for why each comparison is as
 * conservative as it is.
 */
export function leaseRecordTerms(row: LeasePipelineRow): LeaseRecordTerms {
  return {
    residentName: row.residentName,
    leaseStart: row.application?.leaseStart ?? null,
    leaseEnd: row.application?.leaseEnd ?? null,
    rentLabel: row.signedRentLabel ?? null,
  };
}

export function leaseDocumentMismatchesForRow(row: LeasePipelineRow): LeaseDocumentMismatch[] {
  return leaseDocumentMismatches(row.uploadedLeaseParse, leaseRecordTerms(row));
}

/**
 * Why this row's confirmation does not cover its current disagreements, or null
 * when there is nothing outstanding — no mismatches, or an acknowledgement that
 * still binds.
 *
 * ONE answer to "is the record superseded", shared by the send gate, the
 * "Review import" CTA and the review modal. They differ in what they DO about
 * it (below); they must never differ on whether it is true.
 */
export function leaseMismatchAcknowledgementGapForRow(row: LeasePipelineRow): LeaseAcknowledgementGap | null {
  if (leaseDocumentMismatchesForRow(row).length === 0) return null;
  return leaseMismatchAcknowledgementGap(row.uploadedLeaseParse, leaseRecordTerms(row));
}

/**
 * True when a send is still a thing that could happen to this row.
 *
 * NOT `leaseAllowsManagerDocumentEdits`: `sendLeaseToResident` and the agent's
 * `send_lease_for_signature` both accept a row already out for signature
 * (`bucket: "resident"`, no signatures), so scoping the gate to editable rows
 * would leave the assistant able to re-send a lease whose record drifted after
 * it went out. This is the set those send paths actually accept.
 */
export function leaseSendStillReachable(row: LeasePipelineRow): boolean {
  if (row.status === "Fully Signed" || row.status === "Voided") return false;
  return !hasAnyLeaseSignature(row);
}

/**
 * True when the manager should be pointed at the review — the "Review import"
 * CTA and the modal's Confirm button.
 *
 * Narrower than the gate ON PURPOSE. `confirmUploadedLeaseParse` refuses a row
 * that no longer allows document edits, so offering the CTA outside that set
 * would render a primary button whose action always fails and which nothing on
 * screen can clear: a Fully Signed lease whose resident's rent is edited later
 * would grow a permanent, unclearable nag. A row the gate holds but this does
 * not is reachable — "Move to manager review" restores edits and the CTA — and
 * the refusal message says so.
 */
export function leaseNeedsUploadedLeaseReviewAction(row: LeasePipelineRow): boolean {
  if (!leaseAllowsManagerDocumentEdits(row)) return false;
  return leaseAwaitsUploadedLeaseReview(row) || leaseMismatchAcknowledgementGapForRow(row) !== null;
}

/**
 * True when the review is what stands between this row and a signature — the
 * predicate any SENDABILITY claim must read.
 *
 * A surface reads the predicate for the claim it makes: a claim about whether a
 * lease can be sent reads this; an affordance saying "do something here" reads
 * `leaseNeedsUploadedLeaseReviewAction`. Mixing them is how a green
 * "Confirmed … can be sent for signature" banner once sat above a lease every
 * send path refused.
 */
export function leaseSendHeldByUploadedLeaseReview(row: LeasePipelineRow): boolean {
  if (!leaseSendStillReachable(row)) return false;
  return leaseAwaitsUploadedLeaseReview(row) || leaseMismatchAcknowledgementGapForRow(row) !== null;
}

export const LEASE_MOVE_BACK_TO_REVIEW_MESSAGE =
  "Move this lease back to manager review, then confirm the import again before re-sending it.";

export const LEASE_APPLICATION_NOT_APPROVED_MESSAGE =
  "This applicant's application has not been approved. Approve it in Applications before sending a lease for signature.";

/**
 * The application this lease belongs to, when the manager's own applications
 * store has it. Same matching order `findLeaseRowIndexForApprovedApp` uses in
 * the other direction: the Axis id binds exactly, email + property is the
 * fallback for a row whose id was never stamped.
 */
function applicationRowForLease(row: LeasePipelineRow, apps: DemoApplicantRow[]) {
  const email = row.residentEmail.trim().toLowerCase();
  const axisId = row.axisId?.trim();
  if (axisId) {
    const normalized = normalizeApplicationAxisId(axisId);
    const byAxisId = apps.find((a) => a.id?.trim() && normalizeApplicationAxisId(a.id) === normalized);
    if (byAxisId) return byAxisId;
  }
  if (!email) return null;
  const propertyId = row.propertyId?.trim() ?? "";
  const byEmailProperty = apps.find(
    (a) =>
      a.email?.trim().toLowerCase() === email &&
      (a.assignedPropertyId?.trim() || a.propertyId?.trim() || a.application?.propertyId?.trim() || "") === propertyId,
  );
  if (byEmailProperty) return byEmailProperty;
  // Last resort: the person, not the placement. Prefer an approved, live row —
  // someone can hold a pending or withdrawn application for a DIFFERENT property
  // alongside the approved one this lease came from, and picking that first
  // would manufacture a hard, override-less block out of an unrelated record.
  // The whole helper fails open by design; it must not invent a refusal.
  const byEmail = apps.filter((a) => a.email?.trim().toLowerCase() === email);
  return byEmail.find((a) => a.bucket === "approved" && !a.withdrawnAt) ?? byEmail[0] ?? null;
}

/**
 * Why this lease may not be sent for signature yet, or null when it may.
 *
 * A lease is a binding contract, so the applicant must have been approved
 * before one is put in front of them. This is reachable in normal use, not just
 * from seeded data: `syncApprovedApplications` creates the lease row on
 * approval, and moving the application back to Pending afterwards leaves the
 * lease behind, fully sendable.
 *
 * Deliberately fails OPEN when no application row is found. Not every lease has
 * one — an existing resident onboarded off-platform does not — and the
 * applications store is loaded lazily, so refusing on absence would block real
 * sends and look exactly like the "leases not sending" report this lane exists
 * to fix. Refusing on a row that is present and NOT approved is the check with
 * evidence behind it.
 *
 * Pure in `apps` so the assistant's `send_lease_for_signature` can apply the
 * identical rule to rows it read from the database — one decision, never a
 * second weaker copy on the server side.
 */
export function leaseApplicationApprovalBlockerAmong(
  row: LeasePipelineRow,
  apps: DemoApplicantRow[],
): string | null {
  const app = applicationRowForLease(row, apps);
  if (!app) return null;
  if (app.withdrawnAt) {
    return "This applicant withdrew their application. It cannot be sent a lease for signature.";
  }
  if (app.bucket === "approved") return null;
  const state = app.bucket === "rejected" ? "was rejected" : "is still pending review";
  return `${LEASE_APPLICATION_NOT_APPROVED_MESSAGE} (${app.name?.trim() || row.residentName}'s application ${state}.)`;
}

/** The browser's view: judged against the manager's own applications store. */
export function leaseApplicationApprovalBlocker(row: LeasePipelineRow): string | null {
  return leaseApplicationApprovalBlockerAmong(row, readManagerApplicationRows());
}

/**
 * Why this lease may not be sent for signature, or null when it may.
 *
 * ONE ordering, shared by `sendLeaseToResident`, both manager surfaces, and the
 * assistant's `send_lease_for_signature`, so a disabled Send, a refused click
 * and a refused tool call always give the same reason. Ordered by how much the
 * answer tells the manager: an unapproved applicant is a fact about the person,
 * a mismatch names the exact terms that disagree, and the generic review
 * message is the fallback when there is nothing more specific to say.
 *
 * The row's own state (no document, already finalized, already signed) is
 * checked by the callers, which know it without consulting anything else.
 */
/** The literal the template emits when it has no landlord name to print. */
export const LEASE_LANDLORD_PLACEHOLDER = "[LANDLORD ENTITY NAME]";

export const LEASE_LANDLORD_NAME_REQUIRED_MESSAGE =
  "This lease still names \u201c[LANDLORD ENTITY NAME]\u201d as the landlord. Add your landlord legal name in Settings, then regenerate the lease before sending it.";

export const LEASE_LANDLORD_NAME_NOT_CONFIGURED_MESSAGE =
  "Add your landlord legal name in Settings (Lease tab) before sending this lease.";

export const LEASE_LANDLORD_NAME_MISMATCH_MESSAGE =
  "This lease names a different landlord than your Settings legal name. Regenerate the lease so the parties section matches.";

/** Read the bold party name from the generated lease's Parties row. */
export function leaseLandlordPartyNameFromHtml(html: string): string | null {
  const match = html.match(
    /<th[^>]*>\s*Landlord\s*\/\s*Operator\s*<\/th>\s*<td[^>]*>[\s\S]*?<strong>([^<]*)<\/strong>/i,
  );
  const name = match?.[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  return name || null;
}

/**
 * Refuse to send a lease whose landlord party is still the template's placeholder.
 *
 * Deliberately gates on the DOCUMENT rather than on the manager's setting. The setting lives on
 * the server and this gate is synchronous, but that is not the main reason: what matters is what
 * the resident is asked to sign, and reading the artifact also catches a lease generated before
 * the name was set, or one regenerated from a stale context. A document is the evidence; a
 * setting is only an intention.
 *
 * A manager-uploaded PDF is exempt because its bytes are opaque here — its parties are the
 * manager's own, and the uploaded-lease review gate already covers it.
 */
export function leaseLandlordNameBlocker(row: LeasePipelineRow): string | null {
  const html = row.generatedHtml;
  if (!html) return null;
  if (html.includes(LEASE_LANDLORD_PLACEHOLDER)) {
    return LEASE_LANDLORD_NAME_REQUIRED_MESSAGE;
  }
  const configured = cachedLandlordLegalName();
  if (!configured) {
    return LEASE_LANDLORD_NAME_NOT_CONFIGURED_MESSAGE;
  }
  const partyName = leaseLandlordPartyNameFromHtml(html);
  if (partyName && partyName !== configured) {
    return LEASE_LANDLORD_NAME_MISMATCH_MESSAGE;
  }
  return null;
}

export function leaseSendGateBlockerAmong(row: LeasePipelineRow, apps: DemoApplicantRow[]): string | null {
  const approval = leaseApplicationApprovalBlockerAmong(row, apps);
  if (approval) return approval;
  // Parties-mismatch guard. Confirming the review IS the explicit
  // acknowledgement, and it is bound to BOTH sides of the comparison: the
  // document by its digest, the record by `confirmedRecordFingerprint`. A
  // manager who accepts a document's differences and then edits the rent has
  // not accepted the new differences, so the gate re-closes.
  const gap = leaseMismatchAcknowledgementGapForRow(row);
  if (gap) {
    const detail = describeLeaseDocumentMismatches(leaseDocumentMismatchesForRow(row));
    const head = gap === "record_changed" ? LEASE_DOCUMENT_MISMATCH_RECORD_CHANGED_MESSAGE : LEASE_DOCUMENT_MISMATCH_MESSAGE;
    // A row already out for signature cannot be confirmed where it stands
    // (`confirmUploadedLeaseParse` needs document edits), so name the action
    // that IS available rather than a button that is not on screen.
    const next = leaseAllowsManagerDocumentEdits(row) ? "" : ` ${LEASE_MOVE_BACK_TO_REVIEW_MESSAGE}`;
    return `${head} ${detail}${next}`;
  }
  // The confirm-before-sign gate. `sendLeaseToResident` is the only way a lease
  // becomes signable, so guarding it there closes the path rather than only
  // greying out a button.
  if (leaseAwaitsUploadedLeaseReview(row)) {
    const next = leaseAllowsManagerDocumentEdits(row) ? "" : ` ${LEASE_MOVE_BACK_TO_REVIEW_MESSAGE}`;
    return `${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}${next}`;
  }
  // Last, because it is the most mechanical to fix and the least likely: a lease that still
  // names the placeholder as its landlord party must never reach a signature request.
  const landlord = leaseLandlordNameBlocker(row);
  if (landlord) return landlord;
  return null;
}

export function leaseSendGateBlocker(row: LeasePipelineRow): string | null {
  return leaseSendGateBlockerAmong(row, readManagerApplicationRows());
}

/**
 * True when nothing stands between this row and a signature — the ONE predicate
 * a SENDABILITY claim reads.
 *
 * The whole gate, not a subset of it: `leaseSendStillReachable` for the row's
 * own state (a Fully Signed or Voided lease is refused on status alone) plus
 * every reason `leaseSendGateBlocker` answers, in the same order the send paths
 * apply them. A surface that recomposed part of the gate instead drifted three
 * times — the last of them a green "can be sent for signature" banner above a
 * lease whose applicant had been moved back to Pending, which `sendLeaseToResident`
 * refuses. An unapproved application, a parties mismatch and an unread import
 * now all suppress that claim identically.
 */
export function leaseCanBeSentForSignature(row: LeasePipelineRow): boolean {
  if (!leaseSendStillReachable(row)) return false;
  return leaseSendGateBlocker(row) === null;
}

/** True when editing a resident should refresh the lease document (manager-side review only). */
export function leaseSyncsFromResidentEdit(row: LeasePipelineRow): boolean {
  if (!leaseAllowsManagerDocumentEdits(row)) return false;
  return row.status === "Draft" || row.status === "Manager Review";
}

/**
 * A row carrying a signature IS the evidence of what was signed, so its
 * document body can never be replaced in place. Returns `next` with any such
 * replacement reverted to the stored body.
 *
 * This is the choke point rather than a per-mutation check: every mutation in
 * this module funnels through `write`, so a new write path inherits the
 * guarantee instead of having to remember `leaseAllowsManagerDocumentEdits`.
 *
 * It is the SECOND line of defence, not the only one. This runs in the browser
 * against a store the browser controls, so the authoritative check is the same
 * predicate applied server-side in `POST /api/portal-lease-pipeline`, which
 * refuses the write outright. See `replacesSignedLeaseDocument` for the exempt
 * cases.
 */
export function preserveSignedLeaseDocuments(
  prev: LeasePipelineRow[],
  next: LeasePipelineRow[],
): LeasePipelineRow[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((row) => [row.id, row]));
  let reverted = false;
  const guarded = next.map((row) => {
    const before = prevById.get(row.id);
    if (!before || !replacesSignedLeaseDocument(before, row)) return row;
    reverted = true;
    console.warn(`[lease] refused to replace the document of signed lease ${row.id}; kept the executed copy.`);
    return {
      ...row,
      generatedHtml: before.generatedHtml ?? null,
      generatedAtIso: before.generatedAtIso ?? null,
      managerUploadedPdf: before.managerUploadedPdf ?? null,
    };
  });
  return reverted ? guarded : next;
}

export function hasBothLeaseSignatures(row: LeasePipelineRow): boolean {
  return Boolean(row.managerSignature && (row.residentSignature || (row.signatureName && row.signedAtIso)));
}

/** True if the resident has completed their electronic signature (including legacy signature fields). */
export function residentHasSignedLease(row: LeasePipelineRow): boolean {
  return Boolean(
    (row.residentSignature?.name && row.residentSignature?.signedAtIso) || (row.signatureName && row.signedAtIso),
  );
}

export function applyLeaseSignaturesToHtml(row: LeasePipelineRow, html: string | null | undefined): string | null {
  if (!html) return null;
  const withoutExisting = html.replace(/\n?<!-- axis-signatures:start -->[\s\S]*?<!-- axis-signatures:end -->\n?/g, "\n");
  const block = electronicSignatureBlock(row);
  if (!block) return withoutExisting;
  const style = `
    .axis-esign { border-top: 3px double #333; margin-top: 3rem; padding-top: 1.5rem; }
    .axis-esign-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
    .axis-esign-card { border: 1px solid #999; min-height: 108px; padding: 12px; }
    .axis-esign-label { margin: 0 0 0.5rem; font-weight: 700; }
    .axis-esign-name { margin: 0.35rem 0; font-size: 1.35rem; font-family: Georgia, "Times New Roman", serif; font-style: italic; }
    .axis-esign-meta, .axis-esign-pending { margin: 0; color: #555; font-size: 0.85rem; }
    .axis-esign-mono { font-family: "Courier New", monospace; letter-spacing: 0.04em; }
    .axis-esign-provenance { margin: 1rem 0 0; padding-left: 1.1rem; color: #333; font-size: 0.85rem; }
    .axis-esign-fine { margin: 0.5rem 0 0; color: #555; font-size: 0.78rem; }
    .axis-esign-warn { margin: 1rem 0 0; border-left: 3px solid #b00; padding-left: 0.75rem; color: #b00; font-size: 0.85rem; font-weight: 700; }
  `;
  const withStyle = withoutExisting.includes(".axis-esign")
    ? withoutExisting
    : withoutExisting.replace("</style>", `${style}</style>`);
  return withStyle.includes("</body>")
    ? withStyle.replace("</body>", `${block}\n</body>`)
    : `${withStyle}\n${block}`;
}

export type LeaseThreadRole = "manager" | "admin" | "resident";

export type LeaseThreadMessage = {
  id: string;
  at: string;
  role: LeaseThreadRole;
  body: string;
};

export type LeaseSignature = {
  name: string;
  signedAtIso: string;
  role: "manager" | "resident";
  /**
   * SHA-256 of the document THIS party was shown, captured at signature time.
   * Per-signature rather than row-level so that a document which changed
   * between the two signatures is visible instead of silently overwritten.
   * Absent on every signature recorded before this field existed.
   */
  documentSha256?: string | null;
  /** Version of the consent-to-transact-electronically text the signer accepted. */
  consentVersion?: string | null;
};

export type LeaseWorkflowStatus =
  | "Draft"
  | "Manager Review"
  | "Admin Review"
  | "Resident Signature Pending"
  | "Manager Signature Pending"
  | "Fully Signed"
  | "Voided";

export type SignedLeaseSnapshot = {
  id: string;
  label: string;
  fullySignedAt: string;
  leaseTerm?: string;
  leaseStart?: string;
  leaseEnd?: string;
  generatedHtml?: string | null;
  managerUploadedPdf?: LeasePipelineRow["managerUploadedPdf"];
  archivedAtIso: string;
};

export type LeasePipelineRow = {
  id: string;
  residentName: string;
  residentEmail: string;
  unit: string;
  stageLabel: string;
  updated: string;
  bucket: ManagerLeaseBucket;
  pdfVersion: number;
  notes: string;
  updatedAtIso: string;
  axisId?: string;
  propertyId?: string;
  managerUserId?: string | null;
  residentUserId?: string | null;
  roomChoice?: string | null;
  signedRentLabel?: string | null;
  application?: Partial<RentalWizardFormState>;
  generatedHtml?: string | null;
  generatedAtIso?: string | null;
  /** Manager-authored, typed section overrides. The generated HTML stays the source document. */
  managerSectionEdits?: Record<string, LeaseSectionEdit> | null;
  managerUploadedPdf?: { dataUrl: string; fileName: string; uploadedAt: string; originalDataUrl?: string } | null;
  /**
   * PropLane's structured reading of `managerUploadedPdf`, and the manager's
   * review of it. Purely ADDITIVE and derived — it never replaces the upload,
   * which stays the executed artifact (`lease-execution-evidence.ts`).
   *
   * Present and unconfirmed means the lease cannot be sent for signature: see
   * `leaseAwaitsUploadedLeaseReview`. `normalizeLeasePipelineRow` guarantees
   * that any row carrying an upload carries one of these — a row that stored
   * none gets an `unreadUploadedLeaseParse`, so "no reading" cannot mean "no
   * gate". It is absent only when there is no upload to review, or when the row
   * is an executed filing (an off-platform `externallySignedLease`, or anything
   * already signed) that is evidence rather than a document to send.
   */
  uploadedLeaseParse?: UploadedLeaseParse | null;
  thread: LeaseThreadMessage[];
  managerSignature?: LeaseSignature | null;
  residentSignature?: LeaseSignature | null;
  signatureName?: string | null;
  signedAtIso?: string | null;
  status?: LeaseWorkflowStatus;
  currentActorRole?: LeaseThreadRole | "system" | null;
  residentSignedAt?: string | null;
  managerSignedAt?: string | null;
  adminReviewRequestedAt?: string | null;
  sentToResidentAt?: string | null;
  fullySignedAt?: string | null;
  voidedAt?: string | null;
  versionNumber?: number;
  /** Set when manager deletes the saved document — suppresses application draft preview until regenerate/upload. */
  leaseDocumentRemovedAt?: string | null;
  /** Set only after a manager saves an edit to generated lease HTML. */
  managerDocumentEditedAtIso?: string | null;
  /** Underlying terms changed after a manual edit. Sending is blocked until regeneration is confirmed. */
  managerDocumentRegenerationRequiredAtIso?: string | null;
  /** Off-platform lease — both parties treated as signed; no e-sign workflow. */
  externallySignedLease?: boolean;
  /**
   * Execution provenance. All three are optional and absent on every row signed
   * before they existed. Absent means unknown, and unknown is honest. Never
   * backfill a guessed value.
   */
  /** Jurisdiction the lease was executed under, e.g. "US-CA" or "US-CA/san_francisco". */
  executedJurisdiction?: string | null;
  /** Template identifier plus semver, e.g. "ca-residential@1.2.0". */
  templateVersion?: string | null;
  /** PDF selection frozen when an unsigned manager-review document is generated. */
  templateDocumentUrl?: string | null;
  /** Display name paired with `templateDocumentUrl`; not an authorization value. */
  templateDocumentName?: string | null;
  /** SHA-256 of the document as first executed (see `LeaseSignature.documentSha256`). */
  documentSha256?: string | null;
  /**
   * Renewal terms awaiting signatures. Set by the renew flow; consumed (and
   * cleared) after BOTH parties sign, when the terms are applied to the
   * application record and the payment schedule — payments always follow the
   * signed lease, never a draft renewal.
   */
  pendingRenewal?: {
    leaseTerm: string;
    leaseStart: string;
    leaseEnd: string;
    monthlyRent: number | null;
    rentalType?: "standard" | "short_term";
    requestedAtIso: string;
  } | null;
  /** Prior fully-signed lease documents kept when a renewal/amendment clears signatures. */
  signedLeaseSnapshots?: SignedLeaseSnapshot[];
  /** Individual resident lease vs one household joint bundle lease. */
  leaseKind?: LeaseKind;
  jointLeaseGroupId?: string | null;
  jointLeaseBundleId?: string | null;
  jointLeaseMembers?: JointLeaseMember[];
  primaryApplicationId?: string | null;
  bundleGroupKey?: string | null;
  /** Property lease template used for the last generation. */
  leaseGenerationTemplateId?: string | null;
};

function workflowStatusForRow(
  input: Pick<
    LeasePipelineRow,
    "bucket" | "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso" | "voidedAt" | "generatedHtml" | "managerUploadedPdf"
  >,
): LeaseWorkflowStatus {
  const residentSigned = Boolean(
    (input.residentSignature?.name && input.residentSignature?.signedAtIso) || (input.signatureName && input.signedAtIso),
  );
  const managerSigned = Boolean(input.managerSignature?.name && input.managerSignature?.signedAtIso);
  if (input.voidedAt) return "Voided";
  if (managerSigned && residentSigned) return "Fully Signed";
  if (input.bucket === "resident") return "Resident Signature Pending";
  if (input.bucket === "signed") return "Manager Signature Pending";
  return input.generatedHtml || input.managerUploadedPdf ? "Manager Review" : "Draft";
}

function currentActorForStatus(status: LeaseWorkflowStatus): LeasePipelineRow["currentActorRole"] {
  switch (status) {
    case "Draft":
    case "Manager Review":
    case "Manager Signature Pending":
      return "manager";
    case "Admin Review":
      return "manager";
    case "Resident Signature Pending":
      return "resident";
    case "Fully Signed":
    case "Voided":
      return "system";
    default:
      return "system";
  }
}

function stageLabelForStatus(status: LeaseWorkflowStatus): string {
  if (status === "Fully Signed") return "Signed";
  return status;
}

function normalizeManagerSectionEdits(raw: unknown): Record<string, LeaseSectionEdit> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const edits: Record<string, LeaseSectionEdit> = {};
  for (const [sectionId, candidate] of Object.entries(raw)) {
    if (!sectionId.trim() || !candidate || typeof candidate !== "object") continue;
    const edit = candidate as Partial<LeaseSectionEdit>;
    if ((edit.format !== "text" && edit.format !== "rich") || typeof edit.value !== "string") continue;
    edits[sectionId] = { format: edit.format, value: edit.value };
  }
  return Object.keys(edits).length ? edits : null;
}

/** Coerce partial rows from localStorage so UI never reads undefined thread / notes / bucket. */
export function normalizeLeasePipelineRow(raw: unknown): LeasePipelineRow {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LeasePipelineRow>;
  const b = r.bucket;
  const threads = Array.isArray(r.thread) ? r.thread : [];
  const safeThread: LeaseThreadMessage[] = threads.filter(
    (m): m is LeaseThreadMessage =>
      !!m &&
      typeof m === "object" &&
      typeof (m as LeaseThreadMessage).id === "string" &&
      typeof (m as LeaseThreadMessage).body === "string" &&
      typeof (m as LeaseThreadMessage).role === "string",
  );
  const id =
    typeof r.id === "string" && r.id.trim().length > 0
      ? r.id.trim()
      : `lease_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const isoFallback = new Date().toISOString();
  const legacyResidentSignature = normalizeLeaseSignature(
    r.signatureName && r.signedAtIso
      ? { name: r.signatureName, signedAtIso: r.signedAtIso, role: "resident" }
      : null,
    "resident",
  );
  const residentSignature = normalizeLeaseSignature(r.residentSignature, "resident") ?? legacyResidentSignature;
  const managerSignature = normalizeLeaseSignature(r.managerSignature, "manager");
  const legacyBucket = String(b ?? "");
  let bucket: ManagerLeaseBucket = "manager";
  if (legacyBucket === "manager" || legacyBucket === "resident" || legacyBucket === "signed") {
    bucket = legacyBucket;
  } else if (legacyBucket === "admin") {
    bucket = "manager";
  }
  const residentSigned = Boolean(residentSignature?.name && residentSignature.signedAtIso);
  if (residentSigned && !managerSignature && bucket === "resident") bucket = "signed";
  const status = workflowStatusForRow({
    bucket,
    managerSignature,
    residentSignature,
    signatureName: typeof r.signatureName === "string" ? r.signatureName : residentSignature?.name ?? null,
    signedAtIso: typeof r.signedAtIso === "string" ? r.signedAtIso : residentSignature?.signedAtIso ?? null,
    voidedAt: typeof r.voidedAt === "string" ? r.voidedAt : null,
    generatedHtml: r.generatedHtml ?? null,
    managerUploadedPdf: r.managerUploadedPdf ?? null,
  });
  const stageLabel = stageLabelForStatus(status);
  // A row that is already executed is a FILING, not a document waiting to be
  // sent: an off-platform `externallySignedLease`, or anything already carrying
  // a signature. There is nothing left to gate, and asking a manager to review
  // a lease both parties already signed is noise.
  const isExecutedFiling =
    r.externallySignedLease === true || Boolean(residentSignature) || Boolean(managerSignature);
  const versionNumber =
    typeof r.versionNumber === "number" && Number.isFinite(r.versionNumber)
      ? Math.max(1, Math.floor(r.versionNumber))
      : typeof r.pdfVersion === "number" && Number.isFinite(r.pdfVersion)
        ? Math.max(1, Math.floor(r.pdfVersion))
        : 1;

  return {
    id,
    residentName: String(r.residentName ?? "").trim() || "—",
    residentEmail: String(r.residentEmail ?? "").trim(),
    unit: String(r.unit ?? "").trim() || "—",
    stageLabel,
    updated: String(r.updated ?? "").trim() || "—",
    bucket,
    pdfVersion: typeof r.pdfVersion === "number" && Number.isFinite(r.pdfVersion) ? Math.max(0, Math.floor(r.pdfVersion)) : 1,
    notes: stripLeaseAiReviewDisclaimer(typeof r.notes === "string" ? r.notes : String(r.notes ?? "")),
    updatedAtIso: typeof r.updatedAtIso === "string" && r.updatedAtIso.trim() ? r.updatedAtIso : isoFallback,
    axisId: typeof r.axisId === "string" ? r.axisId : undefined,
    propertyId: typeof r.propertyId === "string" ? r.propertyId : undefined,
    managerUserId: typeof r.managerUserId === "string" ? r.managerUserId : null,
    residentUserId: typeof r.residentUserId === "string" ? r.residentUserId : null,
    roomChoice: typeof r.roomChoice === "string" ? r.roomChoice : null,
    signedRentLabel: typeof r.signedRentLabel === "string" ? r.signedRentLabel : null,
    application: r.application,
    // Do not alter persisted historical bytes on read. Section overrides stay
    // separate until they are materialized for signing.
    generatedHtml: stripLeaseAiDisclaimerFromHtml(r.generatedHtml ?? null),
    generatedAtIso: r.generatedAtIso ?? null,
    managerSectionEdits: normalizeManagerSectionEdits(r.managerSectionEdits),
    managerUploadedPdf: r.managerUploadedPdf ?? null,
    // The parse describes ONE uploaded document, so it cannot outlive it. Every
    // path that replaces the upload with generated HTML (the agent's
    // regenerate, section edits, packet edits) writes `managerUploadedPdf:
    // null` through this function, so clearing the derived reading here covers
    // all of them at once instead of leaving a list to keep in sync — and a
    // manager can never be asked to attest against a PDF the row no longer has.
    //
    // An upload with NO stored reading is not exempt from review — it is the
    // least reviewed document there is. It gets an explicit "never read" record
    // so the confirm-before-sign gate holds and the review modal has something
    // to render, instead of the absence quietly meaning "signable".
    uploadedLeaseParse: r.managerUploadedPdf?.dataUrl
      ? normalizeUploadedLeaseParse(r.uploadedLeaseParse) ??
        (isExecutedFiling
          ? null
          : unreadUploadedLeaseParse(
              String(r.managerUploadedPdf.fileName ?? "").trim() || "Uploaded lease.pdf",
            ))
      : null,
    thread: safeThread,
    managerSignature,
    residentSignature,
    signatureName: typeof r.signatureName === "string" ? r.signatureName : residentSignature?.name ?? null,
    signedAtIso: typeof r.signedAtIso === "string" ? r.signedAtIso : residentSignature?.signedAtIso ?? null,
    status,
    currentActorRole:
      (typeof r.currentActorRole === "string" ? (r.currentActorRole as LeasePipelineRow["currentActorRole"]) : null) ??
      currentActorForStatus(status),
    residentSignedAt: typeof r.residentSignedAt === "string" ? r.residentSignedAt : residentSignature?.signedAtIso ?? null,
    managerSignedAt: typeof r.managerSignedAt === "string" ? r.managerSignedAt : managerSignature?.signedAtIso ?? null,
    adminReviewRequestedAt: typeof r.adminReviewRequestedAt === "string" ? r.adminReviewRequestedAt : null,
    sentToResidentAt: typeof r.sentToResidentAt === "string" ? r.sentToResidentAt : null,
    fullySignedAt:
      typeof r.fullySignedAt === "string"
        ? r.fullySignedAt
        : status === "Fully Signed"
          ? managerSignature?.signedAtIso ?? null
          : null,
    voidedAt: typeof r.voidedAt === "string" ? r.voidedAt : null,
    versionNumber,
    leaseDocumentRemovedAt: typeof r.leaseDocumentRemovedAt === "string" ? r.leaseDocumentRemovedAt : null,
    managerDocumentEditedAtIso: typeof r.managerDocumentEditedAtIso === "string" ? r.managerDocumentEditedAtIso : null,
    managerDocumentRegenerationRequiredAtIso:
      typeof r.managerDocumentRegenerationRequiredAtIso === "string" ? r.managerDocumentRegenerationRequiredAtIso : null,
    externallySignedLease: r.externallySignedLease === true,
    executedJurisdiction: optionalTrimmedString(r.executedJurisdiction),
    templateVersion: optionalTrimmedString(r.templateVersion),
    templateDocumentUrl: optionalTrimmedString(r.templateDocumentUrl),
    templateDocumentName: optionalTrimmedString(r.templateDocumentName),
    // DERIVED, never carried forward from storage: it is the hash recorded by
    // the FIRST signature currently on the row. A stored copy went stale the
    // moment a document was replaced and the row re-signed (every reset path
    // spreads `...row` and nulls only the signature fields), which made the
    // certificate print a fingerprint matching no document anyone signed.
    // No signature on the row means nothing has been executed, so null.
    documentSha256: residentSignature?.documentSha256 ?? managerSignature?.documentSha256 ?? null,
    leaseKind: r.leaseKind === "joint_bundle" ? "joint_bundle" : "individual",
    jointLeaseGroupId: typeof r.jointLeaseGroupId === "string" ? r.jointLeaseGroupId : null,
    jointLeaseBundleId: typeof r.jointLeaseBundleId === "string" ? r.jointLeaseBundleId : null,
    jointLeaseMembers: Array.isArray(r.jointLeaseMembers) ? r.jointLeaseMembers : undefined,
    primaryApplicationId: typeof r.primaryApplicationId === "string" ? r.primaryApplicationId : null,
    bundleGroupKey: typeof r.bundleGroupKey === "string" ? r.bundleGroupKey : null,
    leaseGenerationTemplateId:
      typeof r.leaseGenerationTemplateId === "string" ? r.leaseGenerationTemplateId : null,
  };
}

function leasePipelineSessionKey(scopeUserId?: string | null): string {
  // Demo sandbox: one shared store for every scope, so the demo manager and
  // demo resident read/write the SAME lease rows (a resident signature is
  // immediately visible on the manager side and vice versa).
  if (isDemoModeActive()) return `${LEASE_PIPELINE_SESSION_KEY_PREFIX}:shared`;
  if (scopeUserId) return `${LEASE_PIPELINE_SESSION_KEY_PREFIX}:${scopeUserId}`;
  return `${LEASE_PIPELINE_SESSION_KEY_PREFIX}:shared`;
}

function ensureLeasePipelineScope(scopeUserId?: string | null) {
  const nextScope = isDemoModeActive() ? undefined : scopeUserId ?? undefined;
  if (activeLeasePipelineScopeUserId !== nextScope) {
    activeLeasePipelineScopeUserId = nextScope;
    memoryRows = [];
    leasePipelineLastSyncedAt = 0;
    hydrateSuppressedLeaseKeys(nextScope);
  }
}

function leaseSuppressionSessionKey(scopeUserId?: string | null): string {
  if (isDemoModeActive()) return `${LEASE_PIPELINE_SUPPRESSED_KEY_PREFIX}:shared`;
  if (scopeUserId) return `${LEASE_PIPELINE_SUPPRESSED_KEY_PREFIX}:${scopeUserId}`;
  return `${LEASE_PIPELINE_SUPPRESSED_KEY_PREFIX}:shared`;
}

function leaseSuppressionKey(axisId?: string | null, email?: string | null): string {
  const axis = axisId?.trim();
  if (axis) return `axis:${normalizeApplicationAxisId(axis)}`;
  const e = email?.trim().toLowerCase();
  return e ? `email:${e}` : "";
}

function hydrateSuppressedLeaseKeys(scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  try {
    const raw = window.sessionStorage.getItem(leaseSuppressionSessionKey(scopeUserId));
    if (!raw) {
      suppressedLeaseKeys = new Set();
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    suppressedLeaseKeys = new Set(Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []);
  } catch {
    suppressedLeaseKeys = new Set();
  }
}

function persistSuppressedLeaseKeys(scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(
      leaseSuppressionSessionKey(scopeUserId ?? activeLeasePipelineScopeUserId),
      JSON.stringify([...suppressedLeaseKeys]),
    );
  } catch {
    /* ignore */
  }
}

function isLeasePipelineSuppressed(axisId?: string | null, email?: string | null, managerUserId?: string | null): boolean {
  hydrateSuppressedLeaseKeys(managerUserId ?? activeLeasePipelineScopeUserId);
  const key = leaseSuppressionKey(axisId, email);
  return Boolean(key && suppressedLeaseKeys.has(key));
}

/** Allow auto-seeding / recreating a lease row after the manager explicitly removed one. */
export function clearLeasePipelineSuppression(
  axisId?: string | null,
  email?: string | null,
  managerUserId?: string | null,
): void {
  hydrateSuppressedLeaseKeys(managerUserId ?? activeLeasePipelineScopeUserId);
  const key = leaseSuppressionKey(axisId, email);
  if (!key || !suppressedLeaseKeys.has(key)) return;
  suppressedLeaseKeys.delete(key);
  persistSuppressedLeaseKeys(managerUserId);
  materializeLeasePipeline(managerUserId);
}

function suppressLeasePipelineRow(row: LeasePipelineRow, managerUserId?: string | null): void {
  hydrateSuppressedLeaseKeys(managerUserId ?? activeLeasePipelineScopeUserId);
  const key = leaseSuppressionKey(row.axisId, row.residentEmail);
  if (!key) return;
  suppressedLeaseKeys.add(key);
  persistSuppressedLeaseKeys(managerUserId);
}

function filterLeasesForManager(rows: LeasePipelineRow[], managerUserId?: string | null): LeasePipelineRow[] {
  if (!managerUserId) return rows;
  return rows.filter((row) => leaseVisibleToPortalUser(row, managerUserId));
}

function leaseAccessibleToManager(row: LeasePipelineRow | null | undefined, managerUserId?: string | null): row is LeasePipelineRow {
  if (!row) return false;
  if (!managerUserId) return true;
  return leaseVisibleToPortalUser(row, managerUserId);
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function hydrateLeasePipelineFromSession(scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  if (memoryRows.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(leasePipelineSessionKey(scopeUserId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return;
    memoryRows = parsed.map(normalizeLeasePipelineRow);
  } catch {
    /* ignore */
  }
}

function persistLeasePipelineToSession(rows: LeasePipelineRow[], scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(leasePipelineSessionKey(scopeUserId ?? activeLeasePipelineScopeUserId), JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function emit() {
  if (!canUseStorage()) return;
  queueMicrotask(() => {
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
  });
}

function stageLabelForBucket(b: ManagerLeaseBucket): string {
  switch (b) {
    case "manager":
      return "Manager review";
    case "resident":
      return "Resident Signature Pending";
    case "signed":
      return "Manager Signature Pending";
    default:
      return "—";
  }
}

export function leaseRowMatchesManagerTab(row: LeasePipelineRow, tab: ManagerLeaseTab): boolean {
  if (tab === "completed") return row.status === "Fully Signed";
  if (tab === "signed") return row.bucket === "signed" && row.status !== "Fully Signed";
  return row.bucket === tab;
}

export function countManagerLeaseTabs(rows: LeasePipelineRow[]): Record<ManagerLeaseTab, number> {
  return {
    manager: rows.filter((r) => r.bucket === "manager").length,
    resident: rows.filter((r) => r.bucket === "resident").length,
    signed: rows.filter((r) => r.bucket === "signed" && r.status !== "Fully Signed").length,
    completed: rows.filter((r) => r.status === "Fully Signed").length,
  };
}

function formatUpdatedLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function approvedLeasePlacementLabel(input: {
  propertyId?: string;
  propertyLabel?: string;
  roomChoice?: string;
  bundleId?: string;
}): string {
  const propertyTitle =
    (input.propertyId ? getPropertyById(input.propertyId)?.title?.trim() : "") ||
    input.propertyLabel?.trim() ||
    "—";
  if (input.bundleId?.trim() && input.propertyId?.trim()) {
    const bundleLabel = getBundleChoiceLabel(input.propertyId, input.bundleId);
    if (bundleLabel) return `${propertyTitle} · ${bundleLabel}`;
  }
  const roomLabel = input.roomChoice?.trim() ? getRoomChoiceLabel(input.roomChoice).split(" · ")[0]?.trim() || "" : "";
  if (roomLabel) {
    const titleNorm = propertyTitle.toLowerCase();
    const roomNorm = roomLabel.toLowerCase();
    if (titleNorm === roomNorm || titleNorm.endsWith(` · ${roomNorm}`) || titleNorm.includes(` · ${roomNorm} ·`)) {
      return propertyTitle;
    }
  }
  return [propertyTitle, roomLabel].filter(Boolean).join(" · ") || propertyTitle || "—";
}

function bundleGroupRowsFromApplications(
  apps: ReturnType<typeof readManagerApplicationRows>,
): BundleGroupRowInput[] {
  return apps
    .filter((a) => isBundleGroupApplication(a.application))
    .map((a) => ({
      id: a.id,
      name: a.name || a.email || "Applicant",
      email: a.email || "",
      role: a.application?.groupRole ?? null,
      groupId: a.application?.groupId ?? "",
      groupSize: a.application?.groupSize ?? "",
      status:
        a.bucket === "approved"
          ? "approved"
          : a.bucket === "rejected"
            ? "rejected"
            : a.stage === "In progress"
              ? "in_progress"
              : "submitted",
      bundleId: bundleIdForApplication(a.application),
      propertyId: a.assignedPropertyId?.trim() || a.propertyId?.trim() || a.application?.propertyId?.trim() || "",
    }));
}

function syncJointBundleLeases(
  rows: LeasePipelineRow[],
  managerUserId?: string | null,
): { rows: LeasePipelineRow[]; jointMemberAppIds: Set<string> } {
  const allApps = readManagerApplicationRows().filter(
    (a) =>
      a.email?.trim() &&
      isBundleGroupApplication(a.application) &&
      (!managerUserId || applicationVisibleToPortalUser(a, managerUserId)),
  );
  const approvedApps = allApps.filter((a) => a.bucket === "approved");
  const bundleGroups = buildBundleApplicationGroups(bundleGroupRowsFromApplications(allApps));
  const jointMemberAppIds = new Set<string>();
  const next = [...rows];

  for (const group of bundleGroups.values()) {
    if (!bundleGroupReadyForJointLease(group) || !group.bundleId || !group.propertyId) continue;
    // Capture the guarded non-null values into consts: TS loses property narrowing on
    // `group.bundleId` across the function calls below, so read it once here.
    const bundleId = group.bundleId;
    const memberApps = approvedApps.filter((a) => group.members.some((m) => m.id === a.id));
    const organizer = memberApps.find((a) => a.application?.groupRole === "first") ?? memberApps[0];
    if (!organizer) continue;

    for (const m of group.members) jointMemberAppIds.add(m.id);

    const members = buildJointLeaseMembers(memberApps, group);
    const propertyId = group.propertyId;
    const effectiveManagerUserId = organizer.managerUserId ?? managerUserId ?? null;
    const rowId = jointLeaseRowId(group.groupId, bundleId, propertyId);
    const existingIdx = next.findIndex((r) => r.id === rowId || r.bundleGroupKey === bundleGroupKey(group.groupId, bundleId, propertyId));
    const existing = existingIdx !== -1 ? next[existingIdx]! : null;
    const seeded = buildJointLeasePipelineRow({
      group,
      members,
      organizer,
      propertyId,
      managerUserId: effectiveManagerUserId,
      existing,
    });
    const normalized = normalizeLeasePipelineRow(seeded);
    if (existingIdx === -1) next.push(normalized);
    else next[existingIdx] = normalized;
  }

  return { rows: next, jointMemberAppIds };
}

/** Demo seed: load lease-pipeline rows into the local store without server mirror. */
export function seedDemoLeasePipeline(rows: LeasePipelineRow[], scopeUserId: string): void {
  if (!canUseStorage()) return;
  ensureLeasePipelineScope(scopeUserId);
  memoryRows = rows.map(normalizeLeasePipelineRow);
  persistLeasePipelineToSession(memoryRows, scopeUserId);
  leasePipelineLastSyncedAt = Date.now();
  emit();
}

function readRaw(scopeUserId?: string | null): LeasePipelineRow[] | null {
  ensureLeasePipelineScope(scopeUserId);
  hydrateLeasePipelineFromSession(scopeUserId ?? activeLeasePipelineScopeUserId);
  return canUseStorage() ? memoryRows : null;
}

function write(unguardedRows: LeasePipelineRow[], scopeUserId?: string | null) {
  if (!canUseStorage()) return;
  ensureLeasePipelineScope(scopeUserId);
  // `ensureLeasePipelineScope` blanks `memoryRows` on a scope change, and an
  // empty baseline disables the guard. Resident-side writes pass no scope at
  // all, so rehydrate before comparing.
  hydrateLeasePipelineFromSession(scopeUserId ?? activeLeasePipelineScopeUserId);
  const rows = preserveSignedLeaseDocuments(memoryRows, unguardedRows);
  if (!leaseRowsChanged(memoryRows, rows)) return;
  memoryRows = rows;
  persistLeasePipelineToSession(rows, scopeUserId ?? activeLeasePipelineScopeUserId);
  leasePipelineLastSyncedAt = Date.now();
  emit();
  // Demo sandbox is local-only: keep the in-memory/session write but never
  // mirror to the server.
  if (isDemoModeActive()) return;
  const payload = JSON.stringify({ action: "replace", rows });
  const byteLength = new TextEncoder().encode(payload).length;
  const shouldUseRowUpserts = byteLength > 3_500_000 || rows.some((row) => Boolean(row.managerUploadedPdf?.dataUrl));
  if (shouldUseRowUpserts) {
    for (const row of rows) persistLeaseRowToServer(row);
    return;
  }
  void fetch("/api/portal-lease-pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: payload,
  })
    .then(async (res) => {
      if (res.ok) return;
      for (const row of rows) persistLeaseRowToServer(row);
    })
    .catch(() => {
      for (const row of rows) persistLeaseRowToServer(row);
    });
}

function leaseAgreementKey(row: Pick<LeasePipelineRow, "axisId" | "residentEmail" | "propertyId" | "roomChoice">): string {
  return row.axisId?.trim() || `${row.residentEmail.trim().toLowerCase()}::${row.propertyId ?? ""}::${row.roomChoice ?? ""}`;
}

function findRawLeaseRowIndex(rowId: string, managerUserId?: string | null): number {
  const raw = materializeLeasePipeline(managerUserId);
  const directIdx = raw.findIndex((r) => r.id === rowId);
  if (directIdx !== -1) return directIdx;
  const logicalRow = raw.find((r) => r.id === rowId) ?? readLeasePipeline(managerUserId).find((r) => r.id === rowId);
  if (!logicalRow) return -1;
  const logicalKey = leaseAgreementKey(logicalRow);
  const matches = raw
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => leaseAgreementKey(row) === logicalKey);
  if (matches.length === 0) return -1;
  matches.sort((a, b) => {
    const aHasDoc = Number(Boolean(a.row.generatedHtml || a.row.managerUploadedPdf?.dataUrl));
    const bHasDoc = Number(Boolean(b.row.generatedHtml || b.row.managerUploadedPdf?.dataUrl));
    if (bHasDoc !== aHasDoc) return bHasDoc - aHasDoc;
    const aTs = Date.parse(a.row.updatedAtIso || "");
    const bTs = Date.parse(b.row.updatedAtIso || "");
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
  return matches[0]!.idx;
}

export type LeasePipelineActionResult = { ok: true } | { ok: false; error: string };

function persistLeaseRowToServer(row: LeasePipelineRow) {
  if (!canUseStorage() || isDemoModeActive()) return;
  void fetch("/api/portal-lease-pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "upsert", row }),
  }).catch(() => undefined);
}

function persistLeaseDeleteToServer(ids: string[]) {
  if (!canUseStorage() || isDemoModeActive() || ids.length === 0) return;
  void fetch("/api/portal-lease-pipeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "deleteIds", ids }),
  }).catch(() => undefined);
}

async function persistLeaseRowToServerAwait(
  row: LeasePipelineRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canUseStorage()) {
    return { ok: false, error: "Lease could not be saved to the server. Check your connection and try again." };
  }
  if (isDemoModeActive()) return { ok: true };
  try {
    const res = await fetch("/api/portal-lease-pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "upsert", row }),
    });
    if (res.ok) return { ok: true };
    let message = "Lease could not be saved to the server. Check your connection and try again.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error?.trim()) message = body.error.trim();
    } catch {
      // Keep generic fallback when the body is not JSON.
    }
    return { ok: false, error: message };
  } catch {
    return { ok: false, error: "Lease could not be saved to the server. Check your connection and try again." };
  }
}

function findLeaseRowIndexForApprovedApp(
  rows: LeasePipelineRow[],
  app: { id: string; email?: string; assignedPropertyId?: string; propertyId?: string; application?: { propertyId?: string } },
): number {
  const email = app.email?.trim().toLowerCase() ?? "";
  const propertyId =
    app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim() || "";
  const normalizedAppId = normalizeApplicationAxisId(app.id);

  const byAxisId = rows.findIndex(
    (r) => r.axisId?.trim() && normalizeApplicationAxisId(r.axisId) === normalizedAppId,
  );
  if (byAxisId !== -1) return byAxisId;

  if (email) {
    const byEmailProperty = rows.findIndex(
      (r) => r.residentEmail.toLowerCase() === email && (r.propertyId ?? "") === propertyId,
    );
    if (byEmailProperty !== -1) return byEmailProperty;

    // Resident email match when property assignment changed on the application.
    const byEmailOnly = rows.findIndex((r) => r.residentEmail.toLowerCase() === email && Boolean(r.sentToResidentAt || r.generatedHtml || r.managerUploadedPdf));
    if (byEmailOnly !== -1) return byEmailOnly;
  }

  return -1;
}

function syncApprovedApplications(rows: LeasePipelineRow[], managerUserId?: string | null): LeasePipelineRow[] {
  const jointSync = syncJointBundleLeases(rows, managerUserId);
  const next = jointSync.rows;
  const jointMemberAppIds = jointSync.jointMemberAppIds;

  const apps = readManagerApplicationRows().filter(
    (a) =>
      a.bucket === "approved" &&
      a.email?.trim() &&
      (!managerUserId || applicationVisibleToPortalUser(a, managerUserId)),
  );
  let changed = next.length !== rows.length;
  for (const app of apps) {
    if (jointMemberAppIds.has(app.id)) continue;
    if (isLeasePipelineSuppressed(app.id, app.email, managerUserId)) continue;
    const email = app.email!.trim().toLowerCase();
    const propertyId = app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim() || "";
    const roomChoice = app.assignedRoomChoice?.trim() || app.application?.roomChoice1?.trim() || "";
    const effectiveManagerUserId = app.managerUserId ?? managerUserId ?? null;
    const unit = approvedLeasePlacementLabel({
      propertyId,
      propertyLabel: app.property,
      roomChoice,
      bundleId: bundleIdForApplication(app.application),
    });
    const idx = findLeaseRowIndexForApprovedApp(next, app);
    const iso = new Date().toISOString();

    if (app.manuallyAdded) {
      const manualPdf = manualResidentSignedLeasePdf(app);
      if (manualPdf) {
      const existing = idx !== -1 ? next[idx]! : null;
      const residentName = String(app.name ?? "").trim() || "Resident";
      const residentSignature =
        existing?.residentSignature ??
        ({ role: "resident", name: residentName, signedAtIso: iso } satisfies LeaseSignature);
      const managerSignature =
        existing?.managerSignature ??
        ({ role: "manager", name: "Property Manager", signedAtIso: iso } satisfies LeaseSignature);
      const uploadedPdf = existing?.managerUploadedPdf ?? manualPdf ?? null;
      const needsSignedLease =
        !existing || !hasBothLeaseSignatures(existing) || existing.externallySignedLease !== true;
      // Only file the off-platform PDF onto a row that carries NO document yet.
      // A row that already has one (the manager generated and signed in-portal
      // after adding the resident) must not have it swapped for the paper lease
      // because the immutability guard would revert that write, and this reseed runs
      // on every materialize, so it would churn forever instead of converging.
      const needsPdf = Boolean(manualPdf && !existing?.managerUploadedPdf && !existing?.generatedHtml);

      if (!needsSignedLease && !needsPdf && existing) {
        const merged = normalizeLeasePipelineRow({
          ...existing,
          residentName,
          residentEmail: email,
          unit,
          axisId: app.id,
          propertyId: propertyId || undefined,
          managerUserId: effectiveManagerUserId,
          roomChoice: roomChoice || null,
          signedRentLabel: signedRentLabelForRow(app),
        });
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          next[idx] = merged;
          changed = true;
        }
        continue;
      }

      const seeded = normalizeLeasePipelineRow({
        id: existing?.id ?? `lease_app_${app.id}`,
        residentName,
        residentEmail: email,
        unit,
        updated: formatUpdatedLabel(iso),
        bucket: "signed",
        pdfVersion: existing?.pdfVersion ?? 1,
        notes: existing?.notes?.trim() || "Existing resident — lease executed off-platform.",
        updatedAtIso: iso,
        axisId: app.id,
        propertyId: propertyId || undefined,
        managerUserId: effectiveManagerUserId,
        residentUserId: existing?.residentUserId ?? null,
        roomChoice: roomChoice || null,
        signedRentLabel: signedRentLabelForRow(app),
        application: effectiveApplicationForRow(app),
        generatedHtml: existing?.generatedHtml ?? null,
        generatedAtIso: existing?.generatedAtIso ?? null,
        managerUploadedPdf: uploadedPdf,
        thread: existing?.thread ?? [],
        managerSignature,
        residentSignature,
        signatureName: residentSignature.name ?? residentName,
        signedAtIso: residentSignature.signedAtIso ?? iso,
        sentToResidentAt: existing?.sentToResidentAt ?? iso,
        fullySignedAt: existing?.fullySignedAt ?? iso,
        residentSignedAt: existing?.residentSignedAt ?? residentSignature.signedAtIso ?? iso,
        managerSignedAt: existing?.managerSignedAt ?? managerSignature.signedAtIso ?? iso,
        externallySignedLease: true,
      });
      if (idx === -1) next.push(seeded);
      else next[idx] = seeded;
      changed = true;
      continue;
      }
      // No uploaded off-platform PDF — same manager-review workflow as approved applicants.
    }

    const seeded = normalizeLeasePipelineRow({
      id: idx === -1 ? `lease_app_${app.id}` : next[idx]!.id,
      residentName: String(app.name ?? "").trim() || "Applicant",
      residentEmail: email,
      unit,
      stageLabel: idx === -1 ? stageLabelForBucket("manager") : next[idx]!.stageLabel,
      updated: formatUpdatedLabel(iso),
      bucket: idx === -1 ? "manager" : next[idx]!.bucket,
      pdfVersion: idx === -1 ? 1 : next[idx]!.pdfVersion,
      notes: idx === -1
        ? app.manuallyAdded
          ? "Manager-added resident — generate or upload a lease."
          : "Created from approved application."
        : next[idx]!.notes,
      updatedAtIso: idx === -1 ? iso : next[idx]!.updatedAtIso,
      axisId: app.id,
      propertyId: propertyId || undefined,
      managerUserId: effectiveManagerUserId,
      residentUserId: null,
      roomChoice: roomChoice || null,
      signedRentLabel: signedRentLabelForRow(app),
      application: effectiveApplicationForRow(app),
      generatedHtml: idx === -1 ? null : next[idx]!.generatedHtml,
      generatedAtIso: idx === -1 ? null : next[idx]!.generatedAtIso,
      managerUploadedPdf: idx === -1 ? null : next[idx]!.managerUploadedPdf,
      thread: idx === -1 ? [] : next[idx]!.thread,
      managerSignature: idx === -1 ? null : next[idx]!.managerSignature,
      residentSignature: idx === -1 ? null : next[idx]!.residentSignature,
      signatureName: idx === -1 ? null : next[idx]!.signatureName,
      signedAtIso: idx === -1 ? null : next[idx]!.signedAtIso,
    });
    if (idx === -1) {
      next.push(seeded);
      changed = true;
      continue;
    }
    const current = next[idx]!;
    if (
      app.manuallyAdded &&
      !manualResidentSignedLeasePdf(app) &&
      (current.externallySignedLease || hasBothLeaseSignatures(current)) &&
      !current.generatedHtml &&
      !current.managerUploadedPdf?.dataUrl
    ) {
      const repairedIso = new Date().toISOString();
      next[idx] = normalizeLeasePipelineRow({
        ...current,
        residentName: seeded.residentName,
        residentEmail: seeded.residentEmail,
        unit: seeded.unit,
        axisId: app.id,
        propertyId: seeded.propertyId,
        managerUserId: seeded.managerUserId ?? managerUserId ?? current.managerUserId ?? null,
        roomChoice: seeded.roomChoice,
        signedRentLabel: seeded.signedRentLabel,
        application: enrichApplicationForLease(app, effectiveApplicationForRow(app), current.application),
        bucket: "manager",
        generatedHtml: null,
        generatedAtIso: null,
        managerUploadedPdf: null,
        // The parse is derived from the upload; it goes when the upload goes.
        uploadedLeaseParse: null,
        managerSignature: null,
        residentSignature: null,
        signatureName: null,
        signedAtIso: null,
        residentSignedAt: null,
        managerSignedAt: null,
        sentToResidentAt: null,
        fullySignedAt: null,
        adminReviewRequestedAt: null,
        voidedAt: null,
        externallySignedLease: false,
        leaseDocumentRemovedAt: current.leaseDocumentRemovedAt ?? repairedIso,
        status: "Manager Review",
        currentActorRole: "manager",
        updatedAtIso: repairedIso,
        updated: formatUpdatedLabel(repairedIso),
      });
      changed = true;
      continue;
    }
    const merged = normalizeLeasePipelineRow({
      ...current,
      residentName: seeded.residentName,
      residentEmail: seeded.residentEmail,
      unit: seeded.unit,
      axisId: app.id,
      propertyId: seeded.propertyId,
      managerUserId: seeded.managerUserId ?? managerUserId ?? current.managerUserId ?? null,
      roomChoice: seeded.roomChoice,
      signedRentLabel: seeded.signedRentLabel,
      application: enrichApplicationForLease(app, effectiveApplicationForRow(app), current.application),
    });
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      next[idx] = merged;
      changed = true;
    }
  }
  return changed ? next : rows;
}

/** Merge stored row with latest application answers when IDs match. */
function enrichFromApplications(rows: LeasePipelineRow[]): LeasePipelineRow[] {
  const apps = readManagerApplicationRows();
  return rows.map((r) => {
    if (!r.axisId) return r;
    const app = apps.find((a) => a.id === r.axisId);
    if (!app?.application) return r;
    return {
      ...r,
      unit:
        approvedLeasePlacementLabel({
          propertyId: app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim() || "",
          propertyLabel: app.property,
          roomChoice: app.assignedRoomChoice?.trim() || app.application?.roomChoice1?.trim() || "",
        }) || r.unit,
      propertyId: app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim() || r.propertyId,
      managerUserId: app.managerUserId ?? r.managerUserId ?? null,
      roomChoice: app.assignedRoomChoice?.trim() || app.application?.roomChoice1?.trim() || r.roomChoice,
      signedRentLabel: signedRentLabelForRow(app) ?? r.signedRentLabel,
      application: enrichApplicationForLease(app, effectiveApplicationForRow(app), r.application),
      residentName: app.name?.trim() || r.residentName,
      residentEmail: app.email?.trim().toLowerCase() || r.residentEmail,
    };
  });
}

function computeLeasePipelineRows(managerUserId?: string | null): LeasePipelineRow[] {
  ensureLeasePipelineScope(managerUserId);
  hydrateLeasePipelineFromSession(managerUserId);
  const stored = memoryRows.map(normalizeLeasePipelineRow);
  const rows = enrichFromApplications(stored);
  const merged = dedupeLeasePipelineRows(syncApprovedApplications(rows, managerUserId));
  return filterLeasesForManager(merged, managerUserId);
}

/** Persist application-seeded / merged rows so mutations can update raw storage. */
function materializeLeasePipeline(managerUserId?: string | null): LeasePipelineRow[] {
  // Persists without going through `write`, so it needs the same guard.
  const merged = preserveSignedLeaseDocuments(memoryRows, computeLeasePipelineRows(managerUserId));
  if (!leaseRowsChanged(memoryRows, merged)) return merged;
  memoryRows = merged;
  persistLeasePipelineToSession(merged, managerUserId ?? activeLeasePipelineScopeUserId);
  return merged;
}

export function readLeasePipeline(managerUserId?: string | null): LeasePipelineRow[] {
  try {
    return computeLeasePipelineRows(managerUserId);
  } catch {
    memoryRows = [];
    return [];
  }
}

function preferLeasePipelineRow(local: LeasePipelineRow, remote: LeasePipelineRow): LeasePipelineRow {
  const localRank = residentLeasePriority(local);
  const remoteRank = residentLeasePriority(remote);
  if (localRank !== remoteRank) return localRank > remoteRank ? local : remote;
  const localTs = Date.parse(local.updatedAtIso || "");
  const remoteTs = Date.parse(remote.updatedAtIso || "");
  if (localTs !== remoteTs) {
    return (Number.isFinite(localTs) ? localTs : 0) > (Number.isFinite(remoteTs) ? remoteTs : 0) ? local : remote;
  }
  if (local.sentToResidentAt && !remote.sentToResidentAt) return local;
  if (remote.sentToResidentAt && !local.sentToResidentAt) return remote;
  return local;
}

function mergeLeasePipelineRows(local: LeasePipelineRow[], remote: LeasePipelineRow[]): LeasePipelineRow[] {
  const byId = new Map<string, LeasePipelineRow>();
  for (const row of remote) byId.set(row.id, normalizeLeasePipelineRow(row));
  for (const row of local) {
    const normalized = normalizeLeasePipelineRow(row);
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, existing ? preferLeasePipelineRow(normalized, existing) : normalized);
  }
  return [...byId.values()];
}

export async function syncLeasePipelineFromServer(managerUserId?: string | null, opts?: { force?: boolean }): Promise<LeasePipelineRow[]> {
  if (!canUseStorage()) return [];
  ensureLeasePipelineScope(managerUserId);
  hydrateLeasePipelineFromSession(managerUserId);
  if (isDemoModeActive()) return readLeasePipeline(managerUserId);
  // Signed out: stop the interval-driven refetch instead of 401ing forever.
  if (portalSessionEnded()) return readLeasePipeline(managerUserId);
  const force = opts?.force === true;
  if (!force && leasePipelineSyncPromise) return leasePipelineSyncPromise;
  if (!force && leasePipelineLastSyncedAt > 0 && Date.now() - leasePipelineLastSyncedAt < LEASE_PIPELINE_SYNC_TTL_MS) {
    return readLeasePipeline(managerUserId);
  }
  try {
    leasePipelineSyncPromise = (async () => {
      const localSnapshot = readLeasePipeline(managerUserId);
      const res = await fetch("/api/portal-lease-pipeline", { credentials: "include", cache: "no-store" });
      notePortalResponse(res.status);
      if (!res.ok) return localSnapshot;
      const body = (await res.json()) as { rows?: unknown[] };
      const fetched = filterLeasesForManager((body.rows ?? []).map(normalizeLeasePipelineRow), managerUserId);
      // A server row is not automatically more trustworthy than the executed
      // copy already in hand, so the merge result is guarded too. Otherwise a
      // tampered row would land in memory unchallenged and then BECOME the
      // stored body every later write preserves.
      const merged = preserveSignedLeaseDocuments(
        localSnapshot,
        dedupeLeasePipelineRows(mergeLeasePipelineRows(localSnapshot, fetched)),
      );
      memoryRows = merged;
      persistLeasePipelineToSession(merged, managerUserId);
      leasePipelineLastSyncedAt = Date.now();
      emit();
      return readLeasePipeline(managerUserId);
    })();
    return await leasePipelineSyncPromise;
  } finally {
    leasePipelineSyncPromise = null;
  }
}

export function syncLeasePipelineFromApplications(managerUserId?: string | null): LeasePipelineRow[] {
  const next = readLeasePipeline(managerUserId);
  if (canUseStorage() && JSON.stringify(memoryRows) !== JSON.stringify(next)) {
    write(next, managerUserId);
  }
  return next;
}

export function leasePipelineBucketCounts(): [number, number, number] {
  const rows = readLeasePipeline();
  return [
    rows.filter((r) => r.bucket === "manager").length,
    rows.filter((r) => r.bucket === "resident").length,
    rows.filter((r) => r.bucket === "signed").length,
  ];
}

export function residentCanViewLeaseRow(row: LeasePipelineRow | null | undefined): boolean {
  if (!row) return false;
  const hasDocument = Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
  if (!hasDocument) return false;
  return (
    row.status === "Resident Signature Pending" ||
    row.status === "Manager Signature Pending" ||
    row.status === "Fully Signed"
  );
}

/** PropLane-generated lease body only — not uploaded PDFs or static template URLs. */
export function leaseAllowsManagerGeneratedBodyEdits(row: LeasePipelineRow): boolean {
  return (
    leaseAllowsManagerDocumentEdits(row) &&
    Boolean(row.generatedHtml) &&
    !row.managerUploadedPdf?.dataUrl &&
    !row.templateDocumentUrl
  );
}

/** All lease pipeline rows for a manager resident profile, best match first. */
export function leasePipelineRowsForManagerResident(
  managerUserId: string | null | undefined,
  residentEmail: string,
  residentRecordId: string,
): LeasePipelineRow[] {
  const selectedAxisId = normalizeApplicationAxisId(residentRecordId);
  const email = residentEmail.trim().toLowerCase();
  const allRows = readLeasePipeline(managerUserId);
  const rows = allRows.filter((row) =>
    jointLeaseRowIncludesMember(row, { email, applicationId: residentRecordId }),
  );
  rows.sort((a, b) => {
    const aJoint = a.leaseKind === "joint_bundle";
    const bJoint = b.leaseKind === "joint_bundle";
    const jointDelta = Number(bJoint) - Number(aJoint);
    if (jointDelta !== 0) return jointDelta;

    const aAxisMatch = (a.axisId?.trim() ? normalizeApplicationAxisId(a.axisId) : "") === selectedAxisId;
    const bAxisMatch = (b.axisId?.trim() ? normalizeApplicationAxisId(b.axisId) : "") === selectedAxisId;
    const axisDelta = Number(bAxisMatch) - Number(aAxisMatch);
    if (axisDelta !== 0) return axisDelta;

    const visibleDelta = Number(residentCanViewLeaseRow(b)) - Number(residentCanViewLeaseRow(a));
    if (visibleDelta !== 0) return visibleDelta;
    const priorityDelta = residentLeasePriority(b) - residentLeasePriority(a);
    if (priorityDelta !== 0) return priorityDelta;
    const aTs = Date.parse(a.updatedAtIso || "");
    const bTs = Date.parse(b.updatedAtIso || "");
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
  return rows;
}

export type EnsureManagerReviewLeaseResult =
  | { ok: true; row: LeasePipelineRow }
  | { ok: false; error: string };

/**
 * Returns the manager-review lease row for an approved resident, creating one when
 * the pipeline has none (e.g. manager-added resident without an upload at onboarding).
 */
export function ensureManagerReviewLeaseForApplication(
  applicationId: string,
  managerUserId?: string | null,
): EnsureManagerReviewLeaseResult {
  const app = readManagerApplicationRows().find((row) => row.id === applicationId);
  if (!app?.email?.trim()) {
    return { ok: false, error: "Resident record not found." };
  }
  if (app.bucket !== "approved") {
    return { ok: false, error: "Approve this resident before adding a lease." };
  }
  if (isLeasePipelineSuppressed(app.id, app.email, managerUserId)) {
    return { ok: false, error: "Lease was removed for this resident." };
  }

  const email = app.email.trim().toLowerCase();
  const existing = leasePipelineRowsForManagerResident(managerUserId, email, app.id);
  if (existing[0]) return { ok: true, row: existing[0] };

  const iso = new Date().toISOString();
  const propertyId =
    app.assignedPropertyId?.trim() || app.propertyId?.trim() || app.application?.propertyId?.trim() || "";
  const roomChoice = app.assignedRoomChoice?.trim() || app.application?.roomChoice1?.trim() || "";
  const effectiveManagerUserId = app.managerUserId ?? managerUserId ?? null;
  const unit = approvedLeasePlacementLabel({
    propertyId,
    propertyLabel: app.property,
    roomChoice,
    bundleId: bundleIdForApplication(app.application),
  });
  const seeded = normalizeLeasePipelineRow({
    id: `lease_app_${app.id}`,
    residentName: String(app.name ?? "").trim() || "Resident",
    residentEmail: email,
    unit,
    stageLabel: stageLabelForBucket("manager"),
    updated: formatUpdatedLabel(iso),
    bucket: "manager",
    pdfVersion: 1,
    notes: app.manuallyAdded
      ? "Manager-added resident — generate or upload a lease."
      : "Created from approved application.",
    updatedAtIso: iso,
    axisId: app.id,
    propertyId: propertyId || undefined,
    managerUserId: effectiveManagerUserId,
    residentUserId: null,
    roomChoice: roomChoice || null,
    signedRentLabel: signedRentLabelForRow(app),
    application: effectiveApplicationForRow(app),
    generatedHtml: null,
    generatedAtIso: null,
    managerUploadedPdf: null,
    thread: [],
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
  });

  const raw = [...materializeLeasePipeline(managerUserId)];
  raw.push(seeded);
  write(raw, managerUserId);
  const row =
    readLeasePipeline(managerUserId).find((candidate) => candidate.id === seeded.id) ??
    leasePipelineRowsForManagerResident(managerUserId, email, app.id)[0];
  if (!row) return { ok: false, error: "Could not create a lease for this resident." };
  return { ok: true, row };
}

export type ResidentLeaseAuthContext = {
  email?: string | null;
  residentAxisId?: string | null;
  profileManagerId?: string | null;
};

/** True when a lease belongs to the resident's approved manager-client relationship. */
export function residentLeaseAuthorized(row: LeasePipelineRow, ctx: ResidentLeaseAuthContext): boolean {
  const email = ctx.email?.trim().toLowerCase() || "";
  if (!email) return false;

  const isMember = jointLeaseRowIncludesMember(row, {
    email,
    applicationId: ctx.residentAxisId,
  });
  if (!isMember) return false;

  if (row.leaseKind === "joint_bundle") {
    for (const app of readManagerApplicationRows()) {
      if (app.bucket !== "approved" || app.email?.trim().toLowerCase() !== email) continue;
      if (row.jointLeaseMembers?.some((m) => m.applicationId.trim() === app.id.trim())) {
        if (app.managerUserId && row.managerUserId && app.managerUserId === row.managerUserId) return true;
        if (!row.managerUserId || !app.managerUserId) return true;
      }
    }
    return Boolean(row.managerUserId);
  }

  const residentAxisId = ctx.residentAxisId?.trim() || ctx.profileManagerId?.trim() || "";
  if (residentAxisId && row.axisId?.trim()) {
    const normalizedResident = residentAxisId.toUpperCase();
    const normalizedLease = row.axisId.trim().toUpperCase();
    if (normalizedLease === normalizedResident) return true;
  }

  if (residentAxisId) {
    const app = readManagerApplicationRows().find((a) => {
      const appId = a.id.trim().toUpperCase();
      return appId === residentAxisId.toUpperCase() && a.email?.trim().toLowerCase() === email;
    });
    if (app && row.axisId?.trim() && app.id.trim().toUpperCase() === row.axisId.trim().toUpperCase()) return true;
    if (app?.managerUserId && row.managerUserId && app.managerUserId === row.managerUserId) return true;
  }

  // profiles.manager_id can drift onto a stale audit application while the live
  // lease still names the approved application id — match any approved row.
  for (const app of readManagerApplicationRows()) {
    if (app.bucket !== "approved" || app.email?.trim().toLowerCase() !== email) continue;
    if (row.axisId?.trim() && app.id.trim().toUpperCase() === row.axisId.trim().toUpperCase()) return true;
    if (app.managerUserId && row.managerUserId && app.managerUserId === row.managerUserId) return true;
  }

  // API-scoped fetch is authoritative; allow when email matches and no conflicting axis binding.
  return !residentAxisId || !row.axisId?.trim();
}

function residentLeasePriority(row: LeasePipelineRow): number {
  switch (row.status) {
    case "Fully Signed":
      return 5;
    case "Manager Signature Pending":
      return 4;
    case "Resident Signature Pending":
      return 3;
    case "Manager Review":
      return 2;
    case "Admin Review":
      return 2;
    default:
      return 0;
  }
}

export function findLeaseForResidentEmail(email: string, auth?: ResidentLeaseAuthContext): LeasePipelineRow | null {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const ctx: ResidentLeaseAuthContext = { email: e, ...auth };
  const matches = readLeasePipeline().filter((row) =>
    jointLeaseRowIncludesMember(row, { email: e, applicationId: ctx.residentAxisId }),
  ).filter((r) => residentLeaseAuthorized(r, ctx));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const jointDelta = Number(b.leaseKind === "joint_bundle") - Number(a.leaseKind === "joint_bundle");
    if (jointDelta !== 0) return jointDelta;
    const visibleDelta = Number(residentCanViewLeaseRow(b)) - Number(residentCanViewLeaseRow(a));
    if (visibleDelta !== 0) return visibleDelta;
    const priorityDelta = residentLeasePriority(b) - residentLeasePriority(a);
    if (priorityDelta !== 0) return priorityDelta;
    const aTs = Date.parse(a.updatedAtIso || "");
    const bTs = Date.parse(b.updatedAtIso || "");
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
  return matches[0] ?? null;
}

function findActiveResidentLeaseRawIndex(email: string): number {
  const activeRow = findLeaseForResidentEmail(email);
  if (activeRow) {
    const rawIdx = findRawLeaseRowIndex(activeRow.id);
    if (rawIdx !== -1) return rawIdx;
  }
  const key = email.trim().toLowerCase();
  const raw = readRaw() ?? [];
  const matches = raw
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.residentEmail.trim().toLowerCase() === key);
  if (matches.length === 0) return -1;
  matches.sort((a, b) => {
    const aTs = Date.parse(a.row.updatedAtIso || "");
    const bTs = Date.parse(b.row.updatedAtIso || "");
    return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
  });
  return matches[0]!.idx;
}

function makeMsg(role: LeaseThreadRole, body: string): LeaseThreadMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    at: new Date().toISOString(),
    role,
    body: body.trim(),
  };
}

/** Clears off-platform lease upload metadata on the application so sync cannot re-mark the lease signed. */
export function clearManualResidentOffPlatformLeaseFromApplication(axisId: string): void {
  const id = axisId.trim();
  if (!id) return;
  const rows = readManagerApplicationRows();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const row = rows[idx]!;
  if (!row.manuallyAdded) return;
  const details = row.manualResidentDetails;
  if (!details) return;
  const hasOffPlatform =
    details.externallySignedLease === true ||
    Boolean(details.signedLeaseDataUrl?.trim());
  if (!hasOffPlatform) return;
  const nextDetails = { ...details };
  delete nextDetails.externallySignedLease;
  delete nextDetails.signedLeaseDataUrl;
  delete nextDetails.signedLeaseFileName;
  delete nextDetails.signedLeaseUploadedAt;
  const next = [...rows];
  next[idx] = { ...row, manualResidentDetails: nextDetails };
  writeManagerApplicationRows(next);
}

/** Removes lease document content and resets workflow to manager review on the same row. */
export function deleteLeasePipelineRow(id: string, managerUserId?: string | null): boolean {
  const rows = readLeasePipeline(managerUserId);
  const row = rows.find((r) => r.id === id);
  if (!leaseAccessibleToManager(row, managerUserId)) return false;
  if (String(row.residentEmail ?? "").trim()) {
    clearUploadedOwnLease(row.residentEmail);
  }
  const raw = [...materializeLeasePipeline(managerUserId)];
  const rawIdx = findRawLeaseRowIndex(id, managerUserId);
  if (rawIdx === -1) return false;
  const iso = new Date().toISOString();
  if (row.axisId?.trim()) {
    clearManualResidentOffPlatformLeaseFromApplication(row.axisId);
  }
  raw[rawIdx] = normalizeLeasePipelineRow({
    ...row,
    bucket: "manager",
    generatedHtml: null,
    generatedAtIso: null,
    managerUploadedPdf: null,
    // The parse is derived from the upload; it goes when the upload goes.
    uploadedLeaseParse: null,
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    residentSignedAt: null,
    managerSignedAt: null,
    sentToResidentAt: null,
    fullySignedAt: null,
    adminReviewRequestedAt: null,
    voidedAt: null,
    pdfVersion: 1,
    versionNumber: 1,
    status: "Manager Review",
    currentActorRole: "manager",
    externallySignedLease: false,
    leaseDocumentRemovedAt: iso,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  });
  write(raw, managerUserId);
  return true;
}

export function deleteLeasePipelineRowsForResident(
  residentEmail: string,
  axisId?: string | null,
  managerUserId?: string | null,
): number {
  const email = residentEmail.trim().toLowerCase();
  const normalizedAxisId = axisId?.trim() || "";
  if (!email && !normalizedAxisId) return 0;
  const rows = readLeasePipeline(managerUserId);
  const removedRows = rows.filter((row) => {
    const rowEmail = row.residentEmail.trim().toLowerCase();
    return (email && rowEmail === email) || (normalizedAxisId && row.axisId?.trim() === normalizedAxisId);
  });
  if (removedRows.length === 0) return 0;
  for (const row of removedRows) {
    if (String(row.residentEmail ?? "").trim()) {
      clearUploadedOwnLease(row.residentEmail);
    }
    suppressLeasePipelineRow(row, managerUserId);
  }
  const raw = [...(readRaw(managerUserId) ?? [])];
  const removedIds = new Set(removedRows.map((r) => r.id));
  write(
    raw.filter((row) => !removedIds.has(row.id)),
    managerUserId,
  );
  persistLeaseDeleteToServer([...removedIds]);
  return removedRows.length;
}

export function updateLeasePipelineRow(id: string, patch: Partial<LeasePipelineRow>, managerUserId?: string | null): boolean {
  const rows = readLeasePipeline(managerUserId);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  const cur = rows[idx]!;
  if (!leaseAccessibleToManager(cur, managerUserId)) return false;
  const iso = new Date().toISOString();
  const nextRow = normalizeLeasePipelineRow({
    ...cur,
    ...patch,
    updatedAtIso: patch.updatedAtIso ?? iso,
    updated: patch.updated ?? formatUpdatedLabel(patch.updatedAtIso ?? iso),
    versionNumber: patch.versionNumber ?? cur.versionNumber ?? cur.pdfVersion,
  });
  nextRow.stageLabel = patch.stageLabel ?? stageLabelForStatus(nextRow.status ?? workflowStatusForRow(nextRow));
  nextRow.currentActorRole = patch.currentActorRole ?? currentActorForStatus(nextRow.status ?? workflowStatusForRow(nextRow));
  const raw = [...materializeLeasePipeline(managerUserId)];
  const rawIdx = findRawLeaseRowIndex(id, managerUserId);
  if (rawIdx === -1) return false;
  raw[rawIdx] = nextRow;
  write(raw, managerUserId);
  return true;
}

export function getLeaseDocumentHtml(row: LeasePipelineRow): string | null {
  const generatedHtml = stripLeaseAiDisclaimerFromHtml(row.generatedHtml ?? null);
  if (!generatedHtml) return null;
  const sections = parseLeaseHtmlSections(generatedHtml);
  const edits = row.managerSectionEdits;
  const rendered = !sections.length || !edits
    ? generatedHtml
    : rebuildLeaseHtmlFromSections(
        generatedHtml,
        sections.map((section) => {
          const edit = edits[section.id];
          // Stored row_data is client-controlled. A disclosure or ledger edit is
          // never trusted, even if one was written before this invariant existed.
          if (!edit || !isEditableLeaseSection(section)) return section;
          return { ...section, bodyHtml: renderLeaseSectionEdit(edit) };
        }),
      );
  return hasAnyLeaseSignature(row) ? applyLeaseSignaturesToHtml(row, rendered) : rendered;
}

/**
 * Freeze typed manager overrides into the agreement body immediately before a
 * signer can see it. Once a signature exists, this is deliberately a no-op:
 * executed bytes must never be rebuilt from mutable row data.
 */
export function materializeManagerSectionEditsForSignature(row: LeasePipelineRow): LeasePipelineRow {
  if (!row.generatedHtml || !row.managerSectionEdits || hasAnyLeaseSignature(row)) return row;
  const generatedHtml = getLeaseDocumentHtml(row);
  if (!generatedHtml) return row;
  return normalizeLeasePipelineRow({
    ...row,
    generatedHtml,
    managerSectionEdits: null,
  });
}

export function appendLeaseThreadMessage(
  id: string,
  role: LeaseThreadRole,
  body: string,
  managerUserId?: string | null,
): boolean {
  const rows = readLeasePipeline(managerUserId);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  const cur = rows[idx]!;
  if (!leaseAccessibleToManager(cur, managerUserId)) return false;
  const msg = makeMsg(role, body);
  if (!msg.body) return false;
  const iso = new Date().toISOString();
  const nextRow: LeasePipelineRow = {
    ...cur,
    thread: [...(cur.thread ?? []), msg],
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  };
  const raw = [...materializeLeasePipeline(managerUserId)];
  const rawIdx = findRawLeaseRowIndex(id, managerUserId);
  if (rawIdx === -1) return false;
  raw[rawIdx] = nextRow;
  write(raw, managerUserId);
  return true;
}

function applicationSnapshotForLeaseRow(row: LeasePipelineRow): Partial<RentalWizardFormState> | undefined {
  const stored =
    row.application && Object.keys(row.application).length ? row.application : undefined;
  let app: Partial<RentalWizardFormState> | undefined;
  if (row.axisId) {
    const appRow = readManagerApplicationRows().find((a) => a.id === row.axisId);
    if (appRow?.application) {
      app = enrichApplicationForLease(appRow, effectiveApplicationForRow(appRow), stored);
    }
  }
  app = app ?? stored;
  if (!app || !Object.keys(app).length) return undefined;
  return {
    ...app,
    propertyId: app.propertyId?.trim() || row.propertyId?.trim() || undefined,
    roomChoice1: app.roomChoice1?.trim() || row.roomChoice?.trim() || undefined,
    bundleId:
      app.bundleId?.trim() ||
      row.jointLeaseBundleId?.trim() ||
      undefined,
  };
}

/** Merged application answers used for lease generation and template defaults. */
export function leaseApplicationSnapshotForRow(
  row: LeasePipelineRow,
): Partial<RentalWizardFormState> | undefined {
  return applicationSnapshotForLeaseRow(row);
}

/** Bundle group members share one joint lease row — route manager actions there when it exists. */
export function resolveManagerLeaseGenerationRow(
  rowId: string,
  managerUserId?: string | null,
): LeasePipelineRow | null {
  const rows = readLeasePipeline(managerUserId);
  const row = rows.find((candidate) => candidate.id === rowId);
  if (!row) return null;
  if (row.leaseKind === "joint_bundle") return row;

  const joint = rows.find(
    (candidate) =>
      candidate.leaseKind === "joint_bundle" &&
      jointLeaseRowIncludesMember(candidate, {
        email: row.residentEmail,
        applicationId: row.axisId,
      }),
  );
  return joint ?? row;
}

function leaseGenerationContextForRow(
  row: LeasePipelineRow,
  managerUserId?: string | null,
  templateId?: string | null,
) {
  const app = applicationSnapshotForLeaseRow(row);
  if (!app || !Object.keys(app).length) return null;
  let ctx = leaseContextFromApplication(app as RentalWizardFormState);
  // The landlord party. Empty means the manager has not set one yet: the template keeps its old
  // fallback and `leaseLandlordNameBlocker` refuses the send, rather than a building name or the
  // bracket placeholder reaching a document a resident signs.
  const landlordLegalName = cachedLandlordLegalName();
  if (landlordLegalName) ctx = { ...ctx, landlordLegalName };
  if (row.leaseKind === "joint_bundle") {
    ctx = {
      ...ctx,
      leaseKind: "joint_bundle",
      jointLeaseMembers: row.jointLeaseMembers ?? [],
    };
  }
  if (!ctx.listingProperty?.address?.trim() && row.propertyId?.trim()) {
    const prop = getPropertyById(row.propertyId.trim());
    if (prop) {
      ctx = {
        ...ctx,
        listingProperty: prop,
        leasedRoom: ctx.leasedRoom ?? prop,
        submission:
          ctx.submission ??
          (prop.listingSubmission?.v === 1 ? prop.listingSubmission : undefined),
      };
    }
  }
  const pinnedTemplateId = templateId ?? row.leaseGenerationTemplateId;
  if (ctx.submission && pinnedTemplateId) {
    ctx = {
      ...ctx,
      submission: submissionWithLeaseTemplateById(
        normalizeManagerListingSubmissionV1(ctx.submission),
        pinnedTemplateId,
      ),
    };
  }
  return applyLeaseBillingToContext(ctx, row, managerUserId ?? row.managerUserId);
}

/** Build generation context for preview UI (template picker). */
export function leaseGenerationPreviewContextForRow(
  row: LeasePipelineRow,
  managerUserId?: string | null,
  templateId?: string | null,
) {
  return leaseGenerationContextForRow(row, managerUserId, templateId);
}

export function leaseGenerationSupportedForRow(row: LeasePipelineRow): { ok: true } | { ok: false; error: string } {
  const ctx = leaseGenerationContextForRow(row, row.managerUserId);
  if (!ctx) {
    return { ok: false, error: "No application data on file." };
  }
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  return outcome.kind === "generated" ? { ok: true } : { ok: false, error: outcome.error };
}

async function refreshUploadedPdfSignatures(row: LeasePipelineRow): Promise<LeasePipelineRow["managerUploadedPdf"]> {
  const pdf = row.managerUploadedPdf;
  if (!pdf?.dataUrl) return pdf ?? null;
  // Pin the agreement bytes before the first merge. Without this a legacy row
  // that carries only `dataUrl` would have the certificate page appended to an
  // already-merged copy on the second signature, and the guard below could not
  // tell a certificate merge from a document swap.
  const pinned = pdf.originalDataUrl ? pdf : { ...pdf, originalDataUrl: pdf.dataUrl };
  try {
    const merged = await mergeUploadedLeasePdfWithSignatures({ ...row, managerUploadedPdf: pinned });
    if (!merged) return pinned;
    return { ...pinned, dataUrl: merged };
  } catch {
    return pinned;
  }
}

function pdfDataUrl(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return `data:application/pdf;base64,${btoa(binary)}`;
}

/**
 * A manager template remains byte-for-byte intact. Before the first signer sees
 * it, attach the resolved Terms Rider and make that combined PDF the immutable
 * agreement body. The certificate is added only after signatures are captured.
 */
async function prepareManagerTemplatePdfForSignature(
  row: LeasePipelineRow,
  managerUserId?: string | null,
): Promise<{ row: LeasePipelineRow } | { error: string }> {
  if (row.managerUploadedPdf?.dataUrl || hasAnyLeaseSignature(row)) return { row };
  const ctx = leaseGenerationContextForRow(row, managerUserId);
  if (!ctx) return { row };
  const currentTemplate = leaseTemplateDocForContext(ctx);
  const template = row.templateDocumentUrl
    ? {
        url: row.templateDocumentUrl,
        name: row.templateDocumentName || currentTemplate?.name || "Lease template.pdf",
      }
    : currentTemplate;
  if (!template) return { row };
  if (!leaseTemplateObjectPath(template.url) && !legacyLeaseTemplateObjectPath(template.url)) {
    return { error: "The selected lease template is not a stored manager document. Reopen the lease settings and try again." };
  }

  try {
    const response = await fetch(template.url, { credentials: "include", cache: "no-store" });
    if (!response.ok) {
      return { error: "Could not read the selected lease template. Reopen the lease settings and try again." };
    }
    const originalDataUrl = await appendLeaseTermsRiderToPdf(pdfDataUrl(await response.arrayBuffer()), ctx);
    const iso = new Date().toISOString();
    return {
      row: {
        ...row,
        generatedHtml: null,
        generatedAtIso: iso,
        managerUploadedPdf: {
          dataUrl: originalDataUrl,
          originalDataUrl,
          fileName: template.name,
          uploadedAt: iso,
        },
        templateVersion: row.templateVersion ?? leaseTemplateVersionForContext(ctx),
        templateDocumentUrl: row.templateDocumentUrl ?? template.url,
        templateDocumentName: row.templateDocumentName ?? template.name,
      },
    };
  } catch {
    return { error: "Could not prepare the lease terms rider. Check your connection and try again." };
  }
}

export function generateLeaseHtmlForRow(
  rowId: string,
  managerUserId?: string | null,
  options?: { discardManagerEdits?: boolean; templateId?: string | null },
): { ok: true; version: number } | { ok: false; error: string } {
  void options?.discardManagerEdits;
  const resolved = resolveManagerLeaseGenerationRow(rowId, managerUserId);
  const targetId = resolved?.id ?? rowId;
  const rows = readLeasePipeline(managerUserId);
  const row = rows.find((r) => r.id === targetId);
  if (!leaseAccessibleToManager(row, managerUserId)) return { ok: false, error: "Lease not found." };
  if (!leaseAllowsManagerDocumentEdits(row)) {
    return { ok: false, error: "Move the lease back to manager review before generating a new document." };
  }
  const app = applicationSnapshotForLeaseRow(row);
  if (!app || !Object.keys(app).length) {
    return { ok: false, error: "No application data on file — approve an application with saved answers first." };
  }
  const templateId = options?.templateId ?? row.leaseGenerationTemplateId ?? null;
  const ctx = leaseGenerationContextForRow(row, managerUserId, templateId);
  if (!ctx) {
    return { ok: false, error: "No application data on file — approve an application with saved answers first." };
  }
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") return { ok: false, error: outcome.error };
  const version = (row.versionNumber ?? row.pdfVersion) + 1;
  const ok = updateLeasePipelineRow(
    targetId,
    {
      application: app,
      generatedHtml: outcome.html,
      managerUploadedPdf: null,
      // The parse is derived from the upload; it goes when the upload goes.
      uploadedLeaseParse: null,
      generatedAtIso: new Date().toISOString(),
      pdfVersion: version,
      versionNumber: version,
      status: "Manager Review",
      currentActorRole: "manager",
      leaseDocumentRemovedAt: null,
      executedJurisdiction: outcome.executedJurisdiction,
      templateVersion: outcome.templateVersion,
      templateDocumentUrl: outcome.templateDocument?.url ?? null,
      templateDocumentName: outcome.templateDocument?.name ?? null,
      leaseGenerationTemplateId: templateId,
    },
    managerUserId,
  );
  return ok ? { ok: true, version } : { ok: false, error: "Could not save generated lease." };
}

/** Regenerate unsigned manager-review leases after resident or payment edits (never after sent to resident). */
export function regenerateEditableLeasesForResident(
  residentEmail: string,
  managerUserId: string | null | undefined,
  applicationPatch?: Partial<RentalWizardFormState>,
): number {
  const email = residentEmail.trim().toLowerCase();
  if (!email) return 0;
  let updated = 0;
  for (const lr of readLeasePipeline(managerUserId)) {
    if (lr.residentEmail.trim().toLowerCase() !== email) continue;
    if (!leaseSyncsFromResidentEdit(lr)) continue;
    if (!leaseGenerationSupportedForRow(lr).ok) continue;
    if (applicationPatch) {
      updateLeasePipelineRow(
        lr.id,
        { application: { ...(lr.application ?? {}), ...applicationPatch } },
        managerUserId,
      );
    }
    const res = generateLeaseHtmlForRow(lr.id, managerUserId);
    if (res.ok) updated += 1;
  }
  return updated;
}

export async function downloadLeaseFromRow(row: LeasePipelineRow): Promise<PortalDownloadResult> {
  if (typeof window === "undefined") return "failed";
  if (row.managerUploadedPdf?.dataUrl) {
    return downloadDataUrl(
      row.managerUploadedPdf.dataUrl,
      row.managerUploadedPdf.fileName || `PropLane-Lease-${leaseDownloadBaseName(row)}.pdf`,
    );
  }
  const html = getLeaseDocumentHtml(row);
  if (html) {
    return downloadTextContent(
      html,
      `PropLane-Lease-${leaseDownloadBaseName(row)}.html`,
      "text/html;charset=utf-8",
      "Lease",
    );
  }
  return "failed";
}

export function runLeaseDownload(row: LeasePipelineRow, showToast: (message: string) => void): void {
  void downloadLeaseFromRow(row).then((result) => {
    const message = portalDownloadToastMessage(result, "lease");
    if (message) showToast(message);
  });
}

/** @deprecated Use {@link downloadLeaseFromRow} — kept for callers that still name this “print”. */
export async function printLeaseAsPdf(row: LeasePipelineRow): Promise<PortalDownloadResult> {
  return downloadLeaseFromRow(row);
}

export function dedupeLeasePipelineRows(rows: LeasePipelineRow[]): LeasePipelineRow[] {
  const byAgreement = new Map<string, LeasePipelineRow>();
  for (const row of rows) {
    const key =
      row.axisId?.trim() ||
      `${row.residentEmail.trim().toLowerCase()}::${row.propertyId ?? ""}::${row.roomChoice ?? ""}`;
    const existing = byAgreement.get(key);
    if (!existing) {
      byAgreement.set(key, row);
      continue;
    }
    byAgreement.set(key, preferLeasePipelineRow(row, existing));
  }
  return [...byAgreement.values()];
}

export function managerUploadLeasePdf(
  rowId: string,
  file: File,
  managerUserId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (file.type !== "application/pdf") {
      resolve({ ok: false, error: "Please choose a PDF file." });
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      resolve({ ok: false, error: "PDF too large (max 3.5 MB)." });
      return;
    }
    const rows = [...(readRaw(managerUserId) ?? readLeasePipeline(managerUserId))];
    const idx = findRawLeaseRowIndex(rowId, managerUserId);
    const row = idx === -1 ? null : rows[idx]!;
    if (!leaseAccessibleToManager(row, managerUserId) || !String(row.residentEmail ?? "").trim()) {
      resolve({ ok: false, error: "Missing resident email on lease row." });
      return;
    }
    if (!leaseAllowsManagerDocumentEdits(row)) {
      resolve({ ok: false, error: "Move the lease back to manager review before uploading a new PDF." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const payload = {
        dataUrl,
        originalDataUrl: dataUrl,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
      };
      const iso = new Date().toISOString();
      const nextVersion = (row.versionNumber ?? row.pdfVersion) + 1;
      rows[idx] = normalizeLeasePipelineRow({
        ...row,
        bucket: "manager",
        managerUploadedPdf: payload,
        // Written BEFORE any text is read, so the confirm-before-sign gate is
        // closed for the whole window in which the parse could still be running
        // or could fail. A parse that never completes leaves the lease held,
        // not quietly signable. /demo has no parse round trip (it must not call
        // real routes) so it stores none — but it is NOT thereby exempt:
        // normalize gives it an `unreadUploadedLeaseParse`, so the demo shows
        // the same attest-before-send gate with the read step absent.
        uploadedLeaseParse: isDemoModeActive() ? null : pendingUploadedLeaseParse(file.name),
        generatedHtml: null,
        generatedAtIso: null,
        pdfVersion: nextVersion,
        versionNumber: nextVersion,
        status: "Manager Review",
        currentActorRole: "manager",
        updatedAtIso: iso,
        updated: formatUpdatedLabel(iso),
        managerSignature: null,
        residentSignature: null,
        signatureName: null,
        signedAtIso: null,
        residentSignedAt: null,
        managerSignedAt: null,
        sentToResidentAt: null,
        fullySignedAt: null,
        voidedAt: null,
        leaseDocumentRemovedAt: null,
      });
      write(rows, managerUserId);
      resolve({ ok: true });
    };
    reader.onerror = () => resolve({ ok: false, error: "Could not read file." });
    reader.readAsDataURL(file);
  });
}

/**
 * Store the structured reading of an uploaded lease.
 *
 * Refuses once a signature exists and refuses to overwrite a review a human has
 * already confirmed — a late-arriving parse must never silently reopen or
 * replace what a manager signed off on. "Confirmed" is the same judgement the
 * gate makes (`leaseAwaitsUploadedLeaseReview`), so a confirmation that no
 * longer binds to the document does not lock a re-read out; the fresh parse
 * lands unconfirmed and the manager reviews it again.
 */
export function saveUploadedLeaseParse(
  rowId: string,
  parse: UploadedLeaseParse,
  managerUserId?: string | null,
): LeasePipelineActionResult {
  const rows = [...materializeLeasePipeline(managerUserId)];
  const idx = findRawLeaseRowIndex(rowId, managerUserId);
  if (idx === -1) return { ok: false, error: "Lease not found." };
  const row = rows[idx]!;
  if (!leaseAccessibleToManager(row, managerUserId)) return { ok: false, error: "Lease not found." };
  if (hasAnyLeaseSignature(row)) return { ok: false, error: "This lease already has signatures." };
  if (row.uploadedLeaseParse && !uploadedLeaseNeedsManagerConfirmation(row.uploadedLeaseParse)) {
    return { ok: false, error: "This imported lease has already been confirmed." };
  }
  if (!row.managerUploadedPdf?.dataUrl) return { ok: false, error: "No uploaded lease document on this record." };
  const iso = new Date().toISOString();
  rows[idx] = normalizeLeasePipelineRow({
    ...row,
    uploadedLeaseParse: parse,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  });
  write(rows, managerUserId);
  return { ok: true };
}

/**
 * The manager's confirmation. Until this runs, `sendLeaseToResident` refuses.
 *
 * `overrides` are values the manager typed; storing them separately from the
 * extracted `fields` is what lets every surface show which values a human
 * stands behind and which a machine read.
 */
export function confirmUploadedLeaseParse(
  rowId: string,
  args: {
    managerUserId?: string | null;
    confirmedByName?: string | null;
    overrides?: Partial<Record<UploadedLeaseFieldKey, string>>;
    note?: string | null;
  },
): LeasePipelineActionResult {
  const rows = [...materializeLeasePipeline(args.managerUserId)];
  const idx = findRawLeaseRowIndex(rowId, args.managerUserId);
  if (idx === -1) return { ok: false, error: "Lease not found." };
  const row = rows[idx]!;
  if (!leaseAccessibleToManager(row, args.managerUserId)) return { ok: false, error: "Lease not found." };
  const parse = row.uploadedLeaseParse;
  if (!parse) return { ok: false, error: "There is no imported lease to confirm on this record." };
  if (!leaseAllowsManagerDocumentEdits(row)) {
    return { ok: false, error: "Move the lease back to manager review before confirming it." };
  }
  const merged = { ...(parse.review.overrides ?? {}), ...(args.overrides ?? {}) };
  const cleaned: Partial<Record<UploadedLeaseFieldKey, string>> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string" && value.trim()) cleaned[key as UploadedLeaseFieldKey] = value.trim();
  }
  const iso = new Date().toISOString();
  rows[idx] = normalizeLeasePipelineRow({
    ...row,
    uploadedLeaseParse: {
      ...parse,
      review: confirmedUploadedLeaseReview(
        { ...parse.review, overrides: Object.keys(cleaned).length > 0 ? cleaned : undefined },
        {
          userId: args.managerUserId ?? null,
          name: args.confirmedByName ?? null,
          atIso: iso,
          note: args.note,
          documentSha256: parse.sourceSha256,
          // The record the manager was comparing against. Read from the row as
          // it is NOW, including the overrides just merged, so the acknowledgement
          // names the terms actually on screen at confirm time.
          recordFingerprint: leaseRecordFingerprint(leaseRecordTerms(row)),
        },
      ),
    },
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  });
  write(rows, args.managerUserId);
  return { ok: true };
}

export function residentUploadLeasePdf(email: string, file: File): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (file.type !== "application/pdf") {
      resolve({ ok: false, error: "Please choose a PDF file." });
      return;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      resolve({ ok: false, error: "PDF too large (max 3.5 MB)." });
      return;
    }
    const key = email.trim().toLowerCase();
    const rows = [...(readRaw() ?? readLeasePipeline())];
    const idx = findActiveResidentLeaseRawIndex(key);
    const row = idx === -1 ? null : rows[idx]!;
    if (!row) {
      resolve({ ok: false, error: "Lease not found." });
      return;
    }
    if (row.status !== "Resident Signature Pending") {
      resolve({ ok: false, error: "This lease is not currently with the resident." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const iso = new Date().toISOString();
      const nextVersion = (row.versionNumber ?? row.pdfVersion) + 1;
      rows[idx] = normalizeLeasePipelineRow({
        ...row,
        managerUploadedPdf: {
          dataUrl,
          originalDataUrl: dataUrl,
          fileName: file.name,
          uploadedAt: iso,
        },
        // The resident swapped in a different document, so the reading of the
        // manager's file no longer describes what is on this row — keeping it
        // would let an old `sourceSha256` and file name claim to belong to
        // bytes nobody read.
        uploadedLeaseParse: null,
        generatedHtml: null,
        generatedAtIso: null,
        pdfVersion: nextVersion,
        versionNumber: nextVersion,
        updatedAtIso: iso,
        updated: formatUpdatedLabel(iso),
        managerSignature: null,
        residentSignature: null,
        signatureName: null,
        signedAtIso: null,
        residentSignedAt: null,
        managerSignedAt: null,
        fullySignedAt: null,
        bucket: "resident",
        status: "Resident Signature Pending",
      });
      write(rows);
      resolve({ ok: true });
    };
    reader.onerror = () => resolve({ ok: false, error: "Could not read file." });
    reader.readAsDataURL(file);
  });
}

/** Resident electronically signs; row always moves to **signed** (awaiting manager countersign unless already fully executed). */
export async function residentSignLease(
  email: string,
  signatureName?: string,
  consentVersion?: string | null,
): Promise<boolean> {
  const rows = [...(readRaw() ?? readLeasePipeline())];
  const idx = findActiveResidentLeaseRawIndex(email);
  if (idx === -1) return false;
  const row = rows[idx]!;
  if (row.status !== "Resident Signature Pending" || row.bucket !== "resident" || row.residentSignature) return false;
  const iso = new Date().toISOString();
  const trimmedSignature = signatureName?.trim() || row.residentName || "Resident";
  // Hash the bytes the resident was actually shown, BEFORE the signature (and
  // its certificate page) touches the row.
  const documentSha256 = await leaseDocumentSha256(row);
  const residentSignature: LeaseSignature = {
    role: "resident",
    name: trimmedSignature,
    signedAtIso: iso,
    documentSha256,
    // Only what the signer was actually shown. A programmatic caller (the demo
    // playback) renders no consent text, so it records none. A certificate
    // must never attest to a consent nobody gave.
    consentVersion: asConsentVersion(consentVersion),
  };
  const sigMsg = `Resident signed electronically — ${trimmedSignature}.`;
  const thread = [...(row.thread ?? []), makeMsg("resident", sigMsg)];
  const nextRowBase = normalizeLeasePipelineRow({
    ...row,
    residentSignature,
    signatureName: trimmedSignature,
    signedAtIso: iso,
  });
  const bothSigned = hasBothLeaseSignatures(nextRowBase);
  const mergedPdf = await refreshUploadedPdfSignatures(nextRowBase);
  rows[idx] = {
    ...nextRowBase,
    managerUploadedPdf: mergedPdf ?? nextRowBase.managerUploadedPdf,
    bucket: "signed",
    status: bothSigned ? "Fully Signed" : "Manager Signature Pending",
    currentActorRole: bothSigned ? "system" : "manager",
    thread,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
    notes: row.notes,
    residentSignedAt: iso,
    sentToResidentAt: row.sentToResidentAt ?? row.updatedAtIso,
    fullySignedAt: bothSigned ? iso : null,
  };
  write(rows);
  return true;
}

/** Manager / authorized agent electronically countersigns (only after the resident has signed). */
export async function managerSignLease(
  rowId: string,
  signatureName: string,
  managerUserId?: string | null,
  consentVersion?: string | null,
): Promise<boolean> {
  const rows = readLeasePipeline(managerUserId);
  const idx = rows.findIndex((r) => r.id === rowId);
  if (idx === -1) return false;
  const row = rows[idx]!;
  if (!leaseAccessibleToManager(row, managerUserId)) return false;
  if (row.status !== "Manager Signature Pending" || row.bucket !== "signed" || !residentHasSignedLease(row) || row.managerSignature) return false;
  const trimmedSignature = signatureName.trim();
  if (!trimmedSignature) return false;
  const iso = new Date().toISOString();
  // Hash the agreement bytes, not the copy carrying the resident's certificate
  // page (see lease-execution-evidence.ts). Equal to the resident's hash unless
  // the document changed between the two signatures.
  const documentSha256 = await leaseDocumentSha256(row);
  const managerSignature: LeaseSignature = {
    role: "manager",
    name: trimmedSignature,
    signedAtIso: iso,
    documentSha256,
    consentVersion: asConsentVersion(consentVersion),
  };
  const nextRowBase = normalizeLeasePipelineRow({
    ...row,
    managerSignature,
  });
  const bothSigned = hasBothLeaseSignatures(nextRowBase);
  const mergedPdf = await refreshUploadedPdfSignatures(nextRowBase);
  const thread = [...(row.thread ?? []), makeMsg("manager", `Manager signed electronically — ${trimmedSignature}.`)];
  const raw = [...(readRaw(managerUserId) ?? [])];
  const rawIdx = raw.findIndex((r) => r.id === rowId);
  if (rawIdx === -1) return false;
  raw[rawIdx] = {
    ...nextRowBase,
    managerUploadedPdf: mergedPdf ?? nextRowBase.managerUploadedPdf,
    bucket: "signed",
    status: bothSigned ? "Fully Signed" : "Manager Signature Pending",
    currentActorRole: bothSigned ? "system" : "manager",
    thread,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
    managerSignedAt: iso,
    fullySignedAt: bothSigned ? iso : null,
  };
  write(raw, managerUserId);
  return true;
}

export function residentRequestEdits(email: string, message: string): boolean {
  const rows = [...(readRaw() ?? readLeasePipeline())];
  const idx = findActiveResidentLeaseRawIndex(email);
  if (idx === -1) return false;
  const row = rows[idx]!;
  if (row.bucket !== "resident") return false;
  if (!message.trim()) return false;
  const iso = new Date().toISOString();
  const thread = [...(row.thread ?? []), makeMsg("resident", message)];
  rows[idx] = {
    ...row,
    bucket: "manager",
    status: "Manager Review",
    currentActorRole: "manager",
    thread,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  };
  write(rows);
  return true;
}

export function residentSendLeaseToManager(email: string): boolean {
  const key = email.trim().toLowerCase();
  const rows = [...(readRaw() ?? readLeasePipeline())];
  const idx = findActiveResidentLeaseRawIndex(key);
  if (idx === -1) return false;
  const row = rows[idx]!;
  if (row.status !== "Resident Signature Pending") return false;
  if (!row.managerUploadedPdf?.dataUrl) return false;
  const iso = new Date().toISOString();
  const thread = [
    ...(row.thread ?? []),
    makeMsg("resident", "Resident uploaded the signed PDF and sent it back to the manager."),
  ];
  rows[idx] = normalizeLeasePipelineRow({
    ...row,
    bucket: "signed",
    status: "Manager Signature Pending",
    currentActorRole: "manager",
    thread,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  });
  write(rows);
  return true;
}

export async function sendLeaseToResident(rowId: string, managerUserId?: string | null): Promise<LeasePipelineActionResult> {
  const resolved = resolveManagerLeaseGenerationRow(rowId, managerUserId);
  const targetId = resolved?.id ?? rowId;
  const logical = readLeasePipeline(managerUserId).find((r) => r.id === targetId);
  if (!logical || !leaseAccessibleToManager(logical, managerUserId)) {
    return { ok: false, error: "Lease not found." };
  }
  if (!logical.generatedHtml && !logical.managerUploadedPdf?.dataUrl) {
    return { ok: false, error: "Generate or upload a lease document first." };
  }
  if (logical.status === "Fully Signed" || logical.status === "Voided") {
    return { ok: false, error: "This lease is already finalized." };
  }
  if (residentHasSignedLease(logical) || logical.managerSignature) {
    return { ok: false, error: "This lease already has signatures and cannot be re-sent." };
  }
  const gateBlocker = leaseSendGateBlocker(logical);
  if (gateBlocker) return { ok: false, error: gateBlocker };
  const raw = [...materializeLeasePipeline(managerUserId)];
  const idx = findRawLeaseRowIndex(targetId, managerUserId);
  if (idx === -1) return { ok: false, error: "Lease record could not be saved locally." };
  const prepared = await prepareManagerTemplatePdfForSignature(raw[idx]!, managerUserId);
  if ("error" in prepared) return { ok: false, error: prepared.error };
  const beforeMaterialize = prepared.row;
  let row = materializeManagerSectionEditsForSignature(prepared.row);
  const iso = new Date().toISOString();
  if (
    beforeMaterialize.generatedHtml &&
    row.generatedHtml &&
    row.generatedHtml !== beforeMaterialize.generatedHtml &&
    !row.managerUploadedPdf?.dataUrl
  ) {
    const nextVersion = (row.versionNumber ?? row.pdfVersion ?? 1) + 1;
    row = normalizeLeasePipelineRow({
      ...row,
      versionNumber: nextVersion,
      pdfVersion: nextVersion,
      generatedAtIso: iso,
      managerDocumentEditedAtIso: iso,
    });
  }
  const updated = normalizeLeasePipelineRow({
    ...row,
    managerUserId: row.managerUserId ?? managerUserId ?? null,
    bucket: "resident",
    status: "Resident Signature Pending",
    currentActorRole: "resident",
    sentToResidentAt: iso,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
  });
  const persisted = await persistLeaseRowToServerAwait(updated);
  if (!persisted.ok) {
    return persisted;
  }
  raw[idx] = updated;
  write(raw, managerUserId);
  return { ok: true };
}

export function sendLeaseBackToManager(rowId: string, managerUserId?: string | null): LeasePipelineActionResult {
  const rows = readLeasePipeline(managerUserId);
  const idx = rows.findIndex((r) => r.id === rowId);
  if (idx === -1) return { ok: false, error: "Lease not found." };
  const row = rows[idx]!;
  if (!leaseAccessibleToManager(row, managerUserId)) return { ok: false, error: "Lease not found." };
  if (row.status === "Fully Signed" || row.status === "Voided") {
    return { ok: false, error: "This lease is already finalized." };
  }
  const iso = new Date().toISOString();
  const raw = [...materializeLeasePipeline(managerUserId)];
  const rawIdx = findRawLeaseRowIndex(rowId, managerUserId);
  if (rawIdx === -1) return { ok: false, error: "Lease record could not be saved locally." };
  raw[rawIdx] = normalizeLeasePipelineRow({
    ...row,
    bucket: "manager",
    status: "Manager Review",
    currentActorRole: "manager",
    managerSignature: null,
    residentSignature: null,
    signatureName: null,
    signedAtIso: null,
    sentToResidentAt: null,
    residentSignedAt: null,
    managerSignedAt: null,
    fullySignedAt: null,
    updatedAtIso: iso,
    updated: formatUpdatedLabel(iso),
  });
  write(raw, managerUserId);
  return { ok: true };
}
