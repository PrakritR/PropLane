/**
 * Evidence of WHAT was signed.
 *
 * Typed name + timestamp already satisfies ESIGN / state UETA, but a signature
 * is only useful in a dispute if you can prove which bytes it was applied to.
 * Everything here is about pinning that: a SHA-256 of the exact document the
 * signer was shown, and the consent affirmation they accepted to get there.
 *
 * WHICH BYTES. The document a signer sees is either the generated lease HTML
 * (`generatedHtml`, hashed as UTF-8) or the uploaded PDF (hashed as decoded
 * bytes). For the PDF path we hash the ORIGINAL upload, never the copy in
 * `managerUploadedPdf.dataUrl`. That copy has the signature certificate page
 * appended to it, and the certificate cannot contain a hash of itself. The
 * certificate page is a platform artifact; the agreement is the base document.
 */

import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/**
 * Bump when the wording changes. Signatures record the version they accepted,
 * so a certificate never quotes today's text over an older signer's consent.
 */
export const LEASE_ESIGN_CONSENT_VERSION = "esign-consent-v1";

export const LEASE_ESIGN_CONSENT_TEXT =
  "I consent to do business electronically and to receive this agreement and all related records in electronic form. " +
  "I understand that my typed name constitutes my legally binding electronic signature, equivalent to a handwritten signature.";

/** The agreement bytes, excluding any appended signature certificate page. */
export function leaseSignedDocumentBytes(row: LeasePipelineRow): Uint8Array | null {
  // Matches what LeaseSigningModal renders: uploaded PDF wins over generated HTML.
  const pdfBase = row.managerUploadedPdf?.originalDataUrl ?? row.managerUploadedPdf?.dataUrl ?? null;
  if (pdfBase) return dataUrlToBytes(pdfBase);
  if (row.generatedHtml) return new TextEncoder().encode(row.generatedHtml);
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  // ponytail: an insecure origin (plain-http dev host) exposes no WebCrypto.
  // An absent hash is honest; a signature must never fail because of one.
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", new Uint8Array(bytes));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** SHA-256 of the document as presented for signature, or null when there is none. */
export async function leaseDocumentSha256(row: LeasePipelineRow): Promise<string | null> {
  try {
    const bytes = leaseSignedDocumentBytes(row);
    return bytes ? sha256Hex(bytes) : null;
  } catch {
    // A malformed data URL makes `atob` throw. Signing must not fail with it.
    return null;
  }
}

/**
 * A stored hash is data, not a computation. It arrives from `row_data` and is
 * printed on a legal certificate, so anything that is not a SHA-256 digest is
 * rejected rather than rendered as one.
 */
export function asDocumentSha256(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** Readable prefix for a non-technical reader: "3F9A C210 88D1 4E77". */
export function documentFingerprintLabel(hex?: string | null): string | null {
  const clean = hex?.trim().toLowerCase();
  if (!clean) return null;
  return (clean.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ").toUpperCase();
}

/**
 * True when the two parties signed different documents. Impossible through the
 * portal today (a signed row's body is immutable), so it means an out-of-band
 * edit reached the record and the certificate must say so rather than pick one.
 */
export function signedDocumentHashesDiverge(row: LeasePipelineRow): boolean {
  const resident = row.residentSignature?.documentSha256?.trim();
  const manager = row.managerSignature?.documentSha256?.trim();
  return Boolean(resident && manager && resident !== manager);
}

/**
 * Pure signature predicate, defined here rather than in the storage module so
 * server routes can enforce the immutability rule without importing 1700 lines
 * of browser-oriented store. `hasAnyLeaseSignature` delegates to it: one
 * definition, so the client guard and the server guard can never disagree.
 */
export function rowHasAnySignature(row: Pick<LeasePipelineRow, "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso">): boolean {
  return Boolean(row.managerSignature || row.residentSignature || (row.signatureName && row.signedAtIso));
}

/** Manager document-body changes stop when the lease leaves manager review. */
export function leaseAllowsManagerDocumentEdits(
  row: Pick<LeasePipelineRow, "bucket" | "status" | "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso">,
): boolean {
  if (row.status === "Voided" || row.status === "Fully Signed") return false;
  if (rowHasAnySignature(row)) return false;
  return row.bucket === "manager";
}

/**
 * The agreement bytes, excluding the certificate page that signing appends into
 * `managerUploadedPdf.dataUrl`. That page is derived from the signatures, so it
 * legitimately changes as parties sign; the base document must not.
 */
export function leaseDocumentBody(row: LeasePipelineRow): { html: string | null; pdf: string | null } {
  return {
    html: row.generatedHtml ?? null,
    pdf: row.managerUploadedPdf?.originalDataUrl ?? row.managerUploadedPdf?.dataUrl ?? null,
  };
}

export function leaseDocumentBodyChanged(stored: LeasePipelineRow, next: LeasePipelineRow): boolean {
  const before = leaseDocumentBody(stored);
  const after = leaseDocumentBody(next);
  // RAW comparison, deliberately. The signature hash covers the raw stored bytes, so anything
  // looser lets a change the certificate would record slip past the guard. The legacy-row 409
  // this used to cause is fixed at the source instead: the write path no longer rewrites a
  // body that did not change.
  return before.html !== after.html || before.pdf !== after.pdf;
}

/**
 * Every signal that says "this row is executed", as ONE predicate.
 *
 * `rowHasAnySignature` and `fullySignedAt` used to be read by different guards,
 * and each disagreement was a bypass: a payload carrying `fullySignedAt` but no
 * signature object satisfied a signature-keyed guard while still tripping a
 * `fullySignedAt`-keyed action. Anything that decides what an executed row may
 * do reads this, so the two signals can never drift apart again.
 */
export function leaseClaimsExecution(
  row: Pick<
    LeasePipelineRow,
    "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso" | "fullySignedAt"
  >,
): boolean {
  return Boolean(row.fullySignedAt) || rowHasAnySignature(row);
}

/**
 * True when `next` turns an unexecuted stored row into an executed one while
 * ALSO changing the document body — claiming execution of a document the server
 * never held.
 *
 * This is the sibling `replacesSignedLeaseDocument` cannot cover: that one
 * requires the STORED row to already be executed, because it assumes the
 * signature was applied to a body the server had. A caller that supplies the
 * body and the execution claim in the SAME write never trips it, so the executed
 * text is whatever that one request said it was.
 *
 * It is the single trust decision behind two behaviours: a resident-scoped write
 * of this shape is refused outright, and auto-file declines to render such a
 * body into the property owner's document library. Both read this function, so
 * the guard and the action it protects cannot key on different signals.
 *
 * Legitimate shapes stay out of it. `residentUploadLeasePdf` clears every
 * signature and `fullySignedAt` first, so `next` claims nothing, and
 * countersigning leaves the body untouched.
 *
 * It has NO carve-out, deliberately — not even one keyed on the stored row.
 * `row_data` is written verbatim from whatever the client last sent apart from
 * the four scope mirrors, so a stored flag is prior-request client input, not
 * server-established state; honouring `stored.externallySignedLease` here would
 * only move the attacker's write one earlier. (Its sibling may honour that flag
 * because it is reached only when the stored row is ALREADY executed, which is a
 * state the evidence rules have protected up to that point.) The one shape that
 * legitimately fills an ABSENT body with an already-executed off-platform PDF —
 * the existing-resident onboarding row `syncApprovedApplications` seeds — is
 * admitted by the CALLER corroborating those bytes against the manager-filed PDF
 * on the application record, server side; see
 * `leaseBodyMatchesManagerFiledLease`.
 */
export function introducesUntrustedLeaseDocument(
  stored: LeasePipelineRow | undefined,
  next: LeasePipelineRow,
): boolean {
  if (!stored) return false;
  if (leaseClaimsExecution(stored) || !leaseClaimsExecution(next)) return false;
  return leaseDocumentBodyReplaced(stored, next);
}

/**
 * True when `next` replaces the document body of an already-executed `stored`
 * row. Clearing the execution claim drops out by design, because that is a
 * superseding document (void, send back, renew, amend), not a silent edit to an
 * executed one. Filling in an absent body on an `externallySignedLease` row is
 * how existing-resident onboarding files an already-executed off-platform PDF.
 *
 * Keyed on `leaseClaimsExecution`, the same predicate
 * `introducesUntrustedLeaseDocument` bows out on, so the two partition every row
 * shape between them. Keyed on the narrower `rowHasAnySignature`, a row carrying
 * `fullySignedAt` with no signature object was "executed" to one and "unsigned"
 * to the other, and neither protected its body.
 */
export function replacesSignedLeaseDocument(stored: LeasePipelineRow, next: LeasePipelineRow): boolean {
  if (!leaseClaimsExecution(stored) || !leaseClaimsExecution(next)) return false;
  if (!leaseDocumentBodyReplaced(stored, next)) return false;
  const before = leaseDocumentBody(stored);
  if (!before.html && !before.pdf && stored.externallySignedLease) return false;
  return true;
}




function leaseDocumentBodyReplaced(stored: LeasePipelineRow, next: LeasePipelineRow): boolean {
  const before = leaseDocumentBody(stored);
  const after = leaseDocumentBody(next);
  return before.html !== after.html || before.pdf !== after.pdf;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Why a signature write must be refused, or `null` when it is legitimate.
 *
 * The store's `residentSignLease` already refuses a second signature and a row that was never
 * sent — but it runs IN the browser, against a store the browser owns, so it is UX rather than
 * enforcement. `row_data` is writable by the row's own resident, so until this predicate ran
 * server-side the evidence layer's central promise ("a signature records the document THAT
 * party was shown, and a substitution is detectable") held only for well-behaved clients.
 *
 * Two shapes are refused:
 *
 * - **Replacing a signature that already exists.** A second signature over the first destroys
 *   the hash binding the first one recorded, which is the only evidence of what was signed.
 *   Echoing the SAME signature back is not a replacement — ordinary saves resend the whole row.
 * - **Signing a row that is not awaiting that party's signature.** Signing before the lease is
 *   sent means signing something the other party never agreed to send.
 *
 * Deliberately keyed on the signature, not the actor: a manager writing a resident's signature
 * is the same forgery whoever's session it arrives on.
 */
export function leaseSignatureWriteRefusal(
  stored: Pick<
    LeasePipelineRow,
    "bucket" | "status" | "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso"
  >,
  next: Pick<
    LeasePipelineRow,
    "bucket" | "status" | "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso"
  >,
): string | null {
  for (const role of ["resident", "manager"] as const) {
    const before = signatureFor(stored, role, true);
    const after = signatureFor(next, role);
    if (!after.present) continue;

    if (before.present) {
      // An unchanged resend is the normal save path, not a re-signing.
      if (sameSignatureEvidence(before, after)) continue;
      return `This lease already carries the ${role}'s signature; it cannot be signed again.`;
    }

    if (!leaseAwaitsSignature(stored, role)) {
      return `This lease is not awaiting the ${role}'s signature.`;
    }
  }
  return null;
}

type SignatureEvidence = { present: boolean; name: string | null; at: string | null; sha: string | null };

/**
 * A party's signature, from EITHER signal.
 *
 * The resident's signature has two representations: the `residentSignature` object, and the
 * legacy row-level `signatureName` + `signedAtIso` pair that older rows and the store's own
 * write path still use. A guard keyed on only one of them is bypassed by a payload written in
 * the other — the same drift `leaseClaimsExecution` exists to prevent for execution claims.
 */
function signatureFor(
  row: Pick<
    LeasePipelineRow,
    "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso" | "bucket" | "status"
  >,
  role: "manager" | "resident",
  /** Set when reading the STORED row — see the legacy-pair note below. */
  requireStateForLegacyPair = false,
): SignatureEvidence {
  const sig = role === "resident" ? row.residentSignature : row.managerSignature;
  if (sig) {
    return { present: true, name: sig.name ?? null, at: sig.signedAtIso ?? null, sha: sig.documentSha256 ?? null };
  }
  // The legacy pair is the RESIDENT's only; a manager countersignature has always been an
  // object. The two sides read it differently, on purpose:
  //
  // - On the INCOMING row it always counts. The question there is "is this write claiming a
  //   signature?", and a request carrying the pair is claiming one whatever else it says.
  // - On the STORED row it counts only in the state where it would have been written, since
  //   the store stamps `bucket`/`status` in the same write. A stored row carrying the pair in
  //   any other state is residue, and reading it as a held signature would let a genuine
  //   first signature be refused as a duplicate.
  if (role === "resident" && row.signatureName && row.signedAtIso) {
    const corroborated = row.bucket === "resident" && row.status === "Resident Signature Pending";
    if (!requireStateForLegacyPair || corroborated) {
      return { present: true, name: row.signatureName, at: row.signedAtIso, sha: null };
    }
  }
  return { present: false, name: null, at: null, sha: null };
}

/** Two signature records are the same evidence: same signer, same moment, same document. */
function sameSignatureEvidence(a: SignatureEvidence, b: SignatureEvidence): boolean {
  return a.name === b.name && a.at === b.at && a.sha === b.sha;
}

/** Whether the row is at the point where this party's signature is the expected next step. */
export function leaseAwaitsSignature(
  row: Pick<LeasePipelineRow, "bucket" | "status">,
  role: "manager" | "resident",
): boolean {
  if (role === "resident") {
    return row.bucket === "resident" && row.status === "Resident Signature Pending";
  }
  // The manager countersigns only after the resident has signed, which is what moves the row
  // into the signed bucket — the same pair `managerSignLease` checks in the browser.
  return row.bucket === "signed" && row.status === "Manager Signature Pending";
}

/**
 * The role whose signature this write ADDS on someone else's behalf, or `null`.
 *
 * Separate from {@link leaseSignatureWriteRefusal} because the two ask different questions.
 * That one asks whether the ROW may carry this signature at all; this asks whether the ACTOR
 * may be the one adding it. Both are needed: a lease sitting at "Manager Signature Pending" is
 * genuinely awaiting a manager countersignature, so the row-state rule has no reason to refuse
 * one — which left a resident free to write it and mark the lease fully executed against a
 * manager who never signed.
 *
 * Only ADDING is judged. Clearing signatures is an amendment (governed elsewhere), and
 * resending an unchanged signature is what every ordinary save does.
 */
export function leaseSignatureRoleForgedBy(
  stored: Pick<
    LeasePipelineRow,
    "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso" | "bucket" | "status"
  >,
  next: Pick<
    LeasePipelineRow,
    "managerSignature" | "residentSignature" | "signatureName" | "signedAtIso" | "bucket" | "status"
  >,
  actor: "manager" | "resident",
): "manager" | "resident" | null {
  const other = actor === "resident" ? "manager" : "resident";
  const before = signatureFor(stored, other, true);
  const after = signatureFor(next, other);
  if (!after.present) return null;
  if (before.present && sameSignatureEvidence(before, after)) return null;
  return other;
}
