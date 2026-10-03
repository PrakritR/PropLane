/**
 * Does the uploaded lease document describe the tenancy PropLane has on record?
 *
 * A lease page headed "Diego Morales / Cascade Lofts · Unit 2A" once rendered a
 * PDF naming a different tenant, that person's real personal email, a different
 * room and a different rent — with Send fully enabled and no warning anywhere.
 * Nothing in the product objected. This module is what objects.
 *
 * Two rules shape every comparison here, because a FALSE mismatch is expensive
 * too — it blocks a legitimate send and teaches managers to click past the
 * warning:
 *
 * 1. **Only compare what the document actually states.** An `ambiguous` or
 *    `not_found` field is already blank-and-flagged in the review; treating an
 *    unread term as a disagreement would flag almost every document.
 * 2. **Only compare in the comparable form.** Dates and money are compared as
 *    normalized values, so `March 1, 2026` and `2026-03-01` agree and
 *    `01/02/2026` (which means two different days in two conventions, so
 *    `normalizeLeaseDate` deliberately refuses it) is not compared at all.
 *
 * Names are the loosest test on purpose: a real lease names co-tenants, middle
 * names and suffixes, so a disagreement is only reported when the two names
 * share NO word at all. That still catches the case this exists for — an
 * entirely different person — while leaving "Diego Morales" and
 * "Diego A. Morales and Jane Doe" alone. Rule 2 applies to names too: names are
 * compared in every script by default, and refused rather than guessed at only
 * for a cross-script pair or a script with no word boundaries — see
 * `namesDisagree`.
 *
 * `landlordName`, `propertyAddress`, `rentDueDay` and `lateFee` are NOT compared:
 * they have no counterpart on the lease record (`mapsTo: null`), so there is
 * nothing to disagree with. They stay review-only, shown in the review table.
 */

import {
  normalizeLeaseDate,
  normalizeLeaseMoney,
  resolvedFieldValue,
  uploadedLeaseReviewIsConfirmed,
  type UploadedLeaseFieldKey,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";

export type LeaseDocumentMismatch = {
  key: UploadedLeaseFieldKey;
  /** Human label for the term, e.g. "Tenant / Resident". */
  label: string;
  /** What the uploaded document says. */
  documentValue: string;
  /** What the PropLane lease record says. */
  recordValue: string;
};

/**
 * The record side of the comparison. Deliberately a plain shape rather than
 * `LeasePipelineRow`, so this module stays free of the storage layer that
 * imports it.
 */
export type LeaseRecordTerms = {
  residentName?: string | null;
  leaseStart?: string | null;
  leaseEnd?: string | null;
  /** `signedRentLabel`, e.g. "$1,050.00 / month". */
  rentLabel?: string | null;
};

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam"]);

/**
 * Comparable words of a person's name: accents folded away, punctuation and
 * digits dropped, initials and honorifics ignored.
 *
 * Unicode-aware on purpose. An ASCII-only filter produced an empty token set for
 * any name outside the Latin alphabet, and `namesDisagree` fails open on an
 * empty set — so the tenant-name half of this guard was permanently inert for
 * those residents. NFD plus a combining-mark strip also makes "José" and "Jose"
 * the same party rather than two, which is a false mismatch avoided rather than
 * a check loosened.
 */
function nameTokens(raw: string): Set<string> {
  return new Set(
    raw
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !HONORIFICS.has(t)),
  );
}

const LATIN_LETTER = /\p{Script=Latin}/u;

/** True when any comparable word is written in the Latin alphabet. */
function hasLatinLetters(tokens: Set<string>): boolean {
  for (const token of tokens) if (LATIN_LETTER.test(token)) return true;
  return false;
}

/**
 * True when two names cannot plausibly be the same party — they share no word.
 *
 * COMPARE BY DEFAULT. There is deliberately no allowlist of supported scripts:
 * every such list is missing one, and each gap silently re-creates the exact
 * inertness the Unicode-aware tokenizer above exists to remove. Bengali, Tamil,
 * Telugu, Armenian, Georgian, Ethiopic and everything else compare like any
 * other whitespace-delimited script, with no per-script maintenance.
 *
 * Only two conditions make a pair genuinely incomparable, and each one fails
 * OPEN — the same move `normalizeLeaseDate` makes when it refuses `01/02/2026`
 * rather than picking a convention:
 *
 * 1. **Cross-script.** One side is written in the Latin alphabet and the other
 *    is not. A record holding "Wei Zhang" against a document stating "张伟" is
 *    one romanization decision apart, not two people, and reporting it would
 *    hard-block a whole cohort of real leases — a false mismatch is what teaches
 *    managers to click past the warning. A name that carries BOTH, like
 *    "张伟 (Wei Zhang)", counts as Latin and still compares.
 * 2. **No word boundaries.** EITHER side is non-Latin and carries no internal
 *    word boundary — one dense token — which is what a script that does not
 *    delimit words with whitespace (Han, Kana, Hangul, Thai) looks like from
 *    here. Either, not both: a PDF text extraction routinely spaces a CJK name
 *    that the PropLane record holds unspaced, so "田中 太郎" and "田中太郎" share
 *    no token and requiring both sides to be dense reported the SAME person as
 *    a mismatch, in whichever direction the spacing happened to fall.
 *
 *    So a whitespace-free script is deliberately NOT compared on the
 *    tenant-name axis at all, and no containment or per-character test is used
 *    to rescue those pairs: a different given name there is one character, so
 *    any test sharp enough to catch a genuinely different person would also
 *    fire on ordinary formatting variation. Those leases are still covered on
 *    every other axis — lease start, lease end, rent, and the document digest
 *    plus record fingerprint a confirmation binds to.
 *
 * The cost of that is a single-word non-Latin name in a delimited script no
 * longer being compared either, which is accepted: under-reporting a mismatch
 * this cannot judge honestly beats manufacturing one, and a false mismatch is
 * what teaches managers to click past every warning.
 */
function namesDisagree(documentValue: string, recordValue: string): boolean {
  const a = nameTokens(documentValue);
  const b = nameTokens(recordValue);
  if (a.size === 0 || b.size === 0) return false;
  const aIsLatin = hasLatinLetters(a);
  const bIsLatin = hasLatinLetters(b);
  if (aIsLatin !== bIsLatin) return false;
  if (!aIsLatin && (a.size === 1 || b.size === 1)) return false;
  for (const token of a) if (b.has(token)) return false;
  return true;
}

/** Amount from a label like "$1,050.00 / month", or null when there is no plain amount in it. */
function amountFromLabel(raw: string): string | null {
  const match = /\$?\s?\d[\d,]*(?:\.\d{1,2})?/.exec(raw.trim());
  return match ? normalizeLeaseMoney(match[0]) : null;
}

/**
 * Every term the uploaded document states that disagrees with the lease record.
 *
 * Empty when there is no parse, when the parse could not be read, or when
 * nothing comparable disagrees — this never reports a term it did not read.
 */
export function leaseDocumentMismatches(
  parse: UploadedLeaseParse | null | undefined,
  record: LeaseRecordTerms,
): LeaseDocumentMismatch[] {
  if (!parse || parse.status !== "parsed") return [];
  const mismatches: LeaseDocumentMismatch[] = [];

  for (const field of parse.fields) {
    // A value the manager typed IS the manager's decision about this term, so it
    // is compared exactly like an extracted one — a manager who types the wrong
    // tenant should still be told the record disagrees.
    const { value } = resolvedFieldValue(field, parse.review);
    const documentValue = value.trim();
    if (!documentValue) continue;
    if (field.status !== "extracted" && !parse.review.overrides?.[field.key]) continue;

    switch (field.key) {
      case "tenantName": {
        const recordValue = (record.residentName ?? "").trim();
        if (!recordValue || recordValue === "—") break;
        if (namesDisagree(documentValue, recordValue)) {
          mismatches.push({ key: field.key, label: field.label, documentValue, recordValue });
        }
        break;
      }
      case "leaseStart":
      case "leaseEnd": {
        const recordRaw = (field.key === "leaseStart" ? record.leaseStart : record.leaseEnd) ?? "";
        const recordValue = recordRaw.trim();
        if (!recordValue) break;
        const docDate = normalizeLeaseDate(documentValue);
        const recordDate = normalizeLeaseDate(recordValue);
        if (docDate && recordDate && docDate !== recordDate) {
          mismatches.push({ key: field.key, label: field.label, documentValue, recordValue });
        }
        break;
      }
      case "monthlyRent": {
        const recordValue = (record.rentLabel ?? "").trim();
        if (!recordValue) break;
        const docAmount = amountFromLabel(documentValue);
        const recordAmount = amountFromLabel(recordValue);
        if (docAmount && recordAmount && docAmount !== recordAmount) {
          mismatches.push({ key: field.key, label: field.label, documentValue, recordValue });
        }
        break;
      }
      default:
        break;
    }
  }

  return mismatches;
}

/**
 * A stable identity for the record side of the comparison.
 *
 * Stamped onto the review at confirm time so an acknowledgement of "these
 * differences" cannot outlive the record it was made against: the document
 * digest pins WHAT was read, this pins what it was compared TO. Derived from
 * exactly the four terms `leaseDocumentMismatches` compares, IN THE SAME
 * NORMALIZED FORM it compares them in, so a record edit that cannot change the
 * answer cannot needlessly re-gate a lease either: rewriting `2026-03-01` as
 * `March 1, 2026`, or recomputing `signedRentLabel` into another format for the
 * same amount, leaves this identical.
 *
 * Each term falls back to its trimmed raw string where normalization declines
 * to produce one (an unparseable date, a rent label carrying no plain amount),
 * so the fingerprint stays defined and specific rather than collapsing several
 * different records onto one empty value.
 */
export function leaseRecordFingerprint(record: LeaseRecordTerms): string {
  const name = (record.residentName ?? "").trim();
  const start = (record.leaseStart ?? "").trim();
  const end = (record.leaseEnd ?? "").trim();
  const rent = (record.rentLabel ?? "").trim();
  const nameKey = [...nameTokens(name)].sort().join(" ");
  return [
    nameKey || name,
    normalizeLeaseDate(start) ?? start,
    normalizeLeaseDate(end) ?? end,
    amountFromLabel(rent) ?? rent,
  ].join("~");
}

/** Why a confirmation does not cover the record it is being checked against. */
export type LeaseAcknowledgementGap =
  /** No confirmation at all. */
  | "unconfirmed"
  /** Confirmed, and the record has demonstrably changed since. */
  | "record_changed"
  /** Confirmed before the record was ever recorded, so it cannot be compared. */
  | "record_unknown";

/**
 * Whether a confirmation covers the disagreements this record currently has.
 *
 * Only asked when mismatches EXIST — an agreeing lease is never re-gated by a
 * record edit. Fails closed on a missing fingerprint: every confirmation made
 * before that field existed is in that state, and a stored acknowledgement that
 * cannot name what it acknowledged is not evidence a human saw these terms.
 */
export function leaseMismatchAcknowledgementGap(
  parse: UploadedLeaseParse | null | undefined,
  record: LeaseRecordTerms,
): LeaseAcknowledgementGap | null {
  if (!parse) return null;
  if (leaseDocumentMismatches(parse, record).length === 0) return null;
  if (!uploadedLeaseReviewIsConfirmed(parse)) return "unconfirmed";
  const stored = parse.review.confirmedRecordFingerprint;
  if (!stored) return "record_unknown";
  return stored === leaseRecordFingerprint(record) ? null : "record_changed";
}

export const LEASE_DOCUMENT_MISMATCH_MESSAGE =
  "This document disagrees with the lease record. Review the imported lease and confirm the differences before sending it for signature.";

export const LEASE_DOCUMENT_MISMATCH_RECORD_CHANGED_MESSAGE =
  "This document disagrees with the lease record, and the record has changed since this import was confirmed. Review the imported lease and confirm the differences again before sending it for signature.";

/** One-line summary naming exactly what disagrees, for a toast or a tool error. */
export function describeLeaseDocumentMismatches(mismatches: LeaseDocumentMismatch[]): string {
  return mismatches
    .map((m) => `${m.label}: document says “${m.documentValue}”, record says “${m.recordValue}”`)
    .join("; ");
}
