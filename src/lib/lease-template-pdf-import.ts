import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { ApplicationConfigSlice } from "@/lib/rental-application/application-field-catalog";
import type { PdfImportIssue, PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

/**
 * A single source-ordered lease clause, mapped into the SAME
 * `ManagerCustomApplicationField` shape the application-question editor
 * already renders and edits, so the lease import can reuse that editor
 * instead of building a second one.
 *
 * PLACEHOLDER-QUALITY, deliberately: this does not classify clauses into the
 * real lease sections (Acknowledgements, Fees, Pest control, Responsibilities,
 * Indemnification, Rules, House rules, etc — see `proplane-mock-kit`'s Ida
 * Cares brief for what that full classification looks like). It extracts one
 * flat, source-ordered list of paragraph-like blocks per page so the
 * draft -> review -> publish -> compare-original plumbing has real data to
 * exercise end to end. A later task can replace `mapLeaseTemplatePdfImport`
 * with real clause classification without touching the draft/publish/route
 * machinery, because that machinery only depends on this mapping's shape.
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

/**
 * Deterministically maps source-ordered PDF paragraph blocks into a flat list
 * of editable, reviewable rows. It intentionally does not classify clauses
 * into lease sections or invent structure the source text does not have —
 * every block either becomes a row or is reported as an issue, never both and
 * never silently dropped (mirrors `mapApplicationPdfImport`'s conservatism).
 */
export function mapLeaseTemplatePdfImport(source: PdfImportSource): LeaseTemplatePdfImportMapping {
  const questions: ImportedLeaseClause[] = [];
  const issues = [...source.issues];
  const takenKeys = new Set<string>();
  const seenClauses = new Set<string>();

  for (const page of source.pages) {
    for (const block of page.blocks) {
      const cleaned = block.text.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
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
    })),
    applicationConfigMode: "custom",
    questionDisplayOrder: mapping.questions.map((question) => question.id),
  };
}
