import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { ApplicationConfigSlice } from "@/lib/rental-application/application-field-catalog";
import type { PdfColorRun, PdfImportIssue, PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

/**
 * A single source-ordered lease clause, mapped into the SAME
 * `ManagerCustomApplicationField` shape the application-question editor
 * already renders and edits, so the lease import can reuse that editor
 * instead of building a second one.
 *
 * C282: section classification is now REAL, not placeholder — see
 * `looksLikeSectionHeader` below. It is a deterministic heuristic
 * (short, unpunctuated lines read as section headers, same shape as the Ida
 * Cares seed's own "I. Fees" … "VIII. House rules"), not a legal-document
 * parser: a real PDF's own heading style can still fool it (a short
 * un-punctuated clause misread as a header, or a heading with terminal
 * punctuation missed entirely), which is why every clause still carries its
 * full source span and nothing is silently reclassified without a way back —
 * the manager's existing per-question section field in the review editor is
 * the correction path for a misclassified line, same as any other imported
 * field. What changed from the prior flat-list placeholder: a manager
 * importing a real PDF now gets clauses grouped under the headings their own
 * document actually uses, in source order, instead of one undifferentiated
 * "General" bucket.
 */
export type ImportedLeaseClause = ManagerCustomApplicationField & {
  sourcePage: number;
  sourceStart: number;
  sourceEnd: number;
};

export type LeaseTemplatePdfImportMapping = {
  questions: ImportedLeaseClause[];
  issues: PdfImportIssue[];
};

/** A block this short (after trimming) is almost certainly a header, page number, or stray mark — not a clause. */
const MIN_CLAUSE_CHARACTERS = 20;

/** A clause is "predominantly red" (C276) once at least half its characters fall inside a `red` colorRun. */
const RED_CLAUSE_MIN_COVERAGE = 0.5;

/**
 * Real signal, not a guess: `page.colorRuns` (`pdf-source.server.ts`) comes
 * from walking the PDF's own fill-color operators, aligned to this exact
 * block's source offsets. A clause counts as flagged only when the majority
 * of its own characters were actually filled with a red color in the source
 * document — never inferred from keywords or punctuation.
 */
function isPredominantlyRed(colorRuns: PdfColorRun[], start: number, end: number): boolean {
  const length = end - start;
  if (length <= 0) return false;
  let redCharacters = 0;
  for (const run of colorRuns) {
    if (run.color !== "red") continue;
    const overlapStart = Math.max(run.start, start);
    const overlapEnd = Math.min(run.end, end);
    if (overlapEnd > overlapStart) redCharacters += overlapEnd - overlapStart;
  }
  return redCharacters / length >= RED_CLAUSE_MIN_COVERAGE;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** First sentence-ish chunk of a clause, used as the editable question label. */
function clauseLabel(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const cutoff = 90;
  if (cleaned.length <= cutoff) return cleaned;
  const period = cleaned.slice(0, cutoff).lastIndexOf(". ");
  if (period > 20) return `${cleaned.slice(0, period + 1)}`;
  return `${cleaned.slice(0, cutoff).trimEnd()}…`;
}

function uniqueKey(label: string, taken: Set<string>): string {
  const base = normalize(label).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "lease-clause";
  let key = base;
  let suffix = 2;
  while (taken.has(key)) key = `${base}-${suffix++}`;
  taken.add(key);
  return key;
}

/** A section heading this workspace's own imported templates already use, e.g. `"I. Fees"`, `"VIII. House rules"`. */
const ROMAN_NUMERAL_HEADING = /^[ivxlcm]{1,6}\.\s+\S/i;

/** Every lease section this heuristic will name a clause under, until the next detected heading. */
const IMPORTED_LEASE_SECTION_FALLBACK = "General";

/**
 * Deterministic section-header heuristic (C282): a real lease section heading
 * — "I. Fees", "Acknowledgements", "HOUSE RULES" — is short and does NOT end
 * in sentence punctuation, unlike almost every actual clause, which is why
 * this is a decent signal without a document layout model. Two ways in:
 * an explicit roman-numeral heading (this workspace's own convention), or a
 * short (<= 8 words, <= 60 characters) line with no terminal `. ! ?`.
 *
 * Deliberately conservative in ONE direction only: a false positive (a short
 * unpunctuated clause misread as a heading) loses that one clause as a row —
 * acceptable, since the manager's review editor still lets them add it back
 * with the right section. A false negative (a heading this misses) simply
 * leaves the clauses that follow it under whatever section was already
 * current, which is exactly today's placeholder behavior for that one
 * heading — never worse than before this change.
 */
function looksLikeSectionHeader(cleaned: string): boolean {
  if (!cleaned) return false;
  if (ROMAN_NUMERAL_HEADING.test(cleaned)) return true;
  if (cleaned.length > 60) return false;
  if (/[.!?]$/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8;
}

/**
 * Deterministically maps source-ordered PDF paragraph blocks into a
 * source-ordered, SECTION-GROUPED list of editable, reviewable rows (C282).
 * A block confidently classified as a section heading
 * (`looksLikeSectionHeader`) sets the section every clause after it is
 * grouped under, until the next heading — it is consumed as structure, not
 * emitted as its own clause row, matching how the section title itself is
 * never one of its own fields anywhere else in the product (the Ida Cares
 * seed, `buildLeaseFirstSigningHtml`'s per-section `<h2>`). Every OTHER block
 * either becomes a row or is reported as an issue, never both and never
 * silently dropped (mirrors `mapApplicationPdfImport`'s conservatism).
 */
export function mapLeaseTemplatePdfImport(source: PdfImportSource): LeaseTemplatePdfImportMapping {
  const questions: ImportedLeaseClause[] = [];
  const issues = [...source.issues];
  const takenKeys = new Set<string>();
  const seenClauses = new Set<string>();
  let currentSection = IMPORTED_LEASE_SECTION_FALLBACK;

  for (const page of source.pages) {
    for (const block of page.blocks) {
      const cleaned = block.text.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      if (looksLikeSectionHeader(cleaned)) {
        currentSection = cleaned;
        continue;
      }
      if (cleaned.length < MIN_CLAUSE_CHARACTERS) {
        issues.push({
          pageNumber: page.pageNumber,
          code: "lease_clause_too_short_for_review",
          message: `Review short source text at page ${page.pageNumber}, characters ${block.start}-${block.end} — likely a header or page mark, not a clause.`,
        });
        continue;
      }
      const dedupeKey = normalize(cleaned);
      if (seenClauses.has(dedupeKey)) {
        issues.push({
          pageNumber: page.pageNumber,
          code: "lease_clause_repeated_requires_review",
          message: `Review repeated source text at page ${page.pageNumber} — it matches an earlier clause verbatim.`,
        });
        continue;
      }
      seenClauses.add(dedupeKey);
      const label = clauseLabel(cleaned);
      questions.push({
        id: `lease-import-p${page.pageNumber}-${block.start}`,
        key: uniqueKey(label, takenKeys),
        label,
        type: "long_text",
        required: false,
        options: [],
        // Full clause body rides in `description` so the existing question
        // editor's label + help-text fields together hold the whole source
        // row without inventing a third field on `ManagerCustomApplicationField`.
        description: cleaned,
        section: currentSection,
        // C276: a clause the source PDF filled predominantly in red carries
        // that forward as emphasis (see `isPredominantlyRed`), editable by the
        // manager in the review editor for a misread (`ManagerLeaseQuestionsEditorModal`).
        flagged: isPredominantlyRed(page.colorRuns, block.start, block.end) || undefined,
        sourcePage: page.pageNumber,
        sourceStart: block.start,
        sourceEnd: block.end,
      });
    }
    for (const formField of page.formFields ?? []) {
      const label = formField.name.replace(/\s+/g, " ").trim();
      if (!label) {
        issues.push({ pageNumber: page.pageNumber, code: "lease_form_field_label_uncertain", message: "A PDF form field has no readable label. Review the original page." });
        continue;
      }
      issues.push({
        pageNumber: page.pageNumber,
        code: "lease_form_field_requires_review",
        message: `“${label}” is a fillable PDF field, not extracted lease text. Review it against the original page.`,
      });
    }
    for (const issue of page.issues) {
      issues.push({ pageNumber: page.pageNumber, code: "page_unresolved", message: issue });
    }
  }
  return { questions, issues };
}

/** Turns a lease import mapping into a draft question config without publishing it. */
export function leaseImportMappingToDraft(mapping: LeaseTemplatePdfImportMapping): ApplicationConfigSlice {
  return {
    disabledStandardApplicationKeys: [],
    customApplicationFields: mapping.questions.map((question) => ({
      id: question.id,
      key: question.key,
      label: question.label,
      type: question.type,
      required: question.required,
      options: [...question.options],
      description: question.description,
      section: question.section,
      flagged: question.flagged,
    })),
    applicationConfigMode: "custom",
    questionDisplayOrder: mapping.questions.map((question) => question.id),
  };
}
