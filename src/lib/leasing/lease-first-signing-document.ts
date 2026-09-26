/**
 * Ida Cares lease-first (PLAN-0925, C274-C287): renders the resident-facing
 * "final agreement" document for an imported `PropertyLeaseTemplate` — the
 * artifact `begin_lease_first_signing` stores as `generatedHtml` and the one
 * the resident hashes/signs through the existing `residentSignLease` path.
 *
 * Deliberately NOT the full jurisdiction lease generator
 * (`buildPlacementLeaseHtml` / `buildLeaseHtml`): those require an approved
 * application (rental type, dates, jurisdiction) which does not exist yet in
 * a lease-first flow — the whole point is signing BEFORE an application. This
 * is a simpler, self-contained rendering of the published question config's
 * own clauses, in source order, grouped by section, with manager-filled
 * amounts baked in as plain text — plus a short PropLane Terms Rider appended
 * (Akhil's placement model: converted document + a visibly separate rider,
 * never merged into the source clauses).
 *
 * `mapLeaseTemplatePdfImport` (`lease-template-pdf-import.ts`, C282) now
 * classifies real imported PDFs into sections with a deterministic heading
 * heuristic, the same "I. Fees" / "VIII. House rules" shape the Ida Cares
 * seed hand-authors — not a legal-document parser, so an unusually styled
 * source PDF can still misclassify a heading or a short clause. This
 * renderer does not care which pipeline produced `config.section` values; it
 * groups and orders by whatever is there either way.
 */
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

export const PROPLANE_TERMS_RIDER_TITLE = "PropLane Terms Rider";

export const PROPLANE_TERMS_RIDER_BODY =
  "This agreement was converted from a document you provided and is presented " +
  "through PropLane. PropLane is a software platform that helps the property " +
  "operator manage this agreement; it is not a party to it. Electronic " +
  "signature on this document is legally binding under the U.S. ESIGN Act " +
  "and applicable state law. A record of who signed, when, and the exact " +
  "document shown to each signer is retained.";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Section order = first-seen order in `questionDisplayOrder` (source order), falling back to array order. */
function sectionsInOrder(
  fields: ManagerCustomApplicationField[],
  displayOrder: string[] | undefined,
): string[] {
  const orderedFields = displayOrder?.length
    ? [...fields].sort((a, b) => {
        const ai = displayOrder.indexOf(a.id);
        const bi = displayOrder.indexOf(b.id);
        return (ai === -1 ? fields.length : ai) - (bi === -1 ? fields.length : bi);
      })
    : fields;
  const sections: string[] = [];
  for (const field of orderedFields) {
    const section = field.section?.trim() || "General";
    if (!sections.includes(section)) sections.push(section);
  }
  return sections;
}

/** Manager-filled currency value for a fee question, resolved from the property/room the resident is signing for. */
export type LeaseFirstFeeContext = {
  monthlyRent?: number | null;
  dailyRent?: number | null;
  moveInFeeLabel?: string | null;
};

/** Best-effort key-pattern match — the seed/import data names fee questions predictably (`*_monthly`, `*_daily`, `*move_in*`). */
function resolveManagerFeeValue(field: ManagerCustomApplicationField, fees: LeaseFirstFeeContext): string | null {
  const key = field.key.toLowerCase();
  const label = field.label.toLowerCase();
  const isMonthly = key.includes("month") || label.includes("month");
  const isDaily = key.includes("daily") || key.includes("day") || label.includes("daily") || label.includes("per day");
  const isMoveIn = key.includes("move_in") || key.includes("move-in") || label.includes("move-in") || label.includes("move in");
  if (isMoveIn && fees.moveInFeeLabel) return fees.moveInFeeLabel;
  if (isMonthly && typeof fees.monthlyRent === "number") return `$${fees.monthlyRent.toLocaleString("en-US")}`;
  if (isDaily && typeof fees.dailyRent === "number") return `$${fees.dailyRent.toLocaleString("en-US")}`;
  return null;
}

/**
 * Manager-filled amounts for every `filledBy: "manager"` question, resolved
 * once at `begin_lease_first_signing` time and baked into `signingAnswers` as
 * READ-ONLY entries (the resident's wizard never lets these be edited — see
 * `ManagerCustomApplicationField.filledBy`). Questions this cannot resolve
 * (no pattern match) are left out — a manager-filled amount the seed/import
 * did not name predictably shows as "—" rather than a wrong guess.
 */
export function resolveManagerFilledSigningAnswers(
  config: ApplicationTemplateQuestionConfig,
  fees: LeaseFirstFeeContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of config.customApplicationFields) {
    if (field.filledBy !== "manager") continue;
    const value = resolveManagerFeeValue(field, fees);
    if (value) out[field.key] = value;
  }
  return out;
}

/**
 * Renders the full agreement — clauses grouped by section in source order,
 * manager-filled amounts inline as plain text — plus the PropLane Terms
 * Rider, visibly separate (its own heading), never merged into a source
 * clause. This is what gets hashed and signed; it never embeds the resident's
 * per-clause initials (those are signing evidence, tracked separately on
 * `signingAnswers`, exactly like a typed signature is never baked into the
 * document body either).
 */
export function buildLeaseFirstSigningHtml(
  config: ApplicationTemplateQuestionConfig,
  args: {
    propertyLabel: string;
    fees: LeaseFirstFeeContext;
    documentTitle?: string;
  },
): string {
  const managerAnswers = resolveManagerFilledSigningAnswers(config, args.fees);
  const sections = sectionsInOrder(config.customApplicationFields, config.questionDisplayOrder);
  const bySection = new Map<string, ManagerCustomApplicationField[]>();
  for (const field of config.customApplicationFields) {
    const section = field.section?.trim() || "General";
    const list = bySection.get(section) ?? [];
    list.push(field);
    bySection.set(section, list);
  }

  const title = args.documentTitle?.trim() || "License Agreement";
  const parts: string[] = [];
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  parts.push(`<p class="lease-first-property">${escapeHtml(args.propertyLabel)}</p>`);

  for (const section of sections) {
    const fields = bySection.get(section) ?? [];
    if (!fields.length) continue;
    parts.push(`<h2>${escapeHtml(section)}</h2>`);
    for (const field of fields) {
      const clauseText = (field.description?.trim() || field.label).trim();
      if (field.type === "currency" && field.filledBy === "manager") {
        const value = managerAnswers[field.key] ?? "—";
        parts.push(`<p><strong>${escapeHtml(field.label)}:</strong> ${escapeHtml(value)}</p>`);
      } else {
        parts.push(`<p>${escapeHtml(clauseText)}</p>`);
      }
    }
  }

  parts.push(`<h2>${escapeHtml(PROPLANE_TERMS_RIDER_TITLE)}</h2>`);
  parts.push(`<p>${escapeHtml(PROPLANE_TERMS_RIDER_BODY)}</p>`);

  return parts.join("\n");
}

export type LeaseFirstAnswerFact = { key: string; label: string; value: string };
export type LeaseFirstAnswersSection = { section: string; facts: LeaseFirstAnswerFact[] };

/**
 * Groups every clause's answer by section, in source order (C281) — the
 * Answers section on the lease record page, same shape as the Applications
 * record page's own "Application form" section (one card per section, in
 * source order). Reads `signingAnswers` exactly as recorded; never invents a
 * value for an unanswered clause.
 */
export function leaseFirstAnswersBySection(
  config: ApplicationTemplateQuestionConfig,
  answers: Record<string, string> | null | undefined,
): LeaseFirstAnswersSection[] {
  const sections = sectionsInOrder(config.customApplicationFields, config.questionDisplayOrder);
  const bySection = new Map<string, ManagerCustomApplicationField[]>();
  for (const field of config.customApplicationFields) {
    const section = field.section?.trim() || "General";
    const list = bySection.get(section) ?? [];
    list.push(field);
    bySection.set(section, list);
  }
  const out: LeaseFirstAnswersSection[] = [];
  for (const section of sections) {
    const fields = bySection.get(section) ?? [];
    if (!fields.length) continue;
    const facts: LeaseFirstAnswerFact[] = fields.map((field) => {
      const raw = answers?.[field.key]?.trim();
      const value = raw || (field.type === "initials" ? "Not yet initialed" : "—");
      return { key: field.key, label: field.label, value };
    });
    out.push({ section, facts });
  }
  return out;
}

/** Total required `initials`-type questions and how many `signingAnswers` already answers — the "N of M initials" fact. */
export function leaseFirstInitialsProgress(
  config: ApplicationTemplateQuestionConfig | null | undefined,
  answers: Record<string, string> | null | undefined,
): { answered: number; total: number } | null {
  if (!config) return null;
  const initialsFields = config.customApplicationFields.filter((field) => field.type === "initials");
  if (!initialsFields.length) return null;
  const answered = initialsFields.filter((field) => Boolean(answers?.[field.key]?.trim())).length;
  return { answered, total: initialsFields.length };
}
