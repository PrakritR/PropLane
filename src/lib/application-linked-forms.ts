/**
 * Linked-form rules: "when the answer to THIS question is X, include THAT form".
 *
 * Stored as `linkedForms` on the question config, next to `showIf`:
 *  - a custom question keeps them on its own `customApplicationFields` row;
 *  - a built-in question keeps them on its override row (the `customApplicationFields` row that carries
 *    its `standardKey`), the same row that already holds a built-in's reworded label or Required flag.
 *
 * Pure and dependency-free so the question normalizer, the editor and the tests can all import it.
 */

export type LinkedFormRef = { kind: "application" | "move_in"; id: string };

export type LinkedFormRule = {
  id: string;
  /** "yes" | "no" | "any" | ">0" | one choice of a pick question (its stored text). */
  whenEquals: string;
  formRef: LinkedFormRef;
  neededBeforeReview: boolean;
};

/** The built-in "Co-signer planned" question; the template's co-signer link is read as a rule on it. */
export const COSIGNER_QUESTION_STANDARD_KEY = "household-co-signer-planned";

const DERIVED_COSIGNER_RULE_ID = "lfr-derived-cosigner";

let ruleCounter = 0;
export function mintLinkedFormRuleId(): string {
  ruleCounter += 1;
  return `lfr-${Date.now().toString(36)}-${ruleCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Coerces stored rules into a clean array (drops malformed rows and repeated ids). */
export function normalizeLinkedFormRules(raw: unknown): LinkedFormRule[] {
  if (!Array.isArray(raw)) return [];
  const out: LinkedFormRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ref = o.formRef;
    if (!ref || typeof ref !== "object") continue;
    const kind = (ref as { kind?: unknown }).kind;
    const refId = (ref as { id?: unknown }).id;
    if ((kind !== "application" && kind !== "move_in") || typeof refId !== "string" || !refId.trim()) continue;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : mintLinkedFormRuleId();
    if (seen.has(id)) continue;
    seen.add(id);
    const whenEquals = typeof o.whenEquals === "string" && o.whenEquals.trim() ? o.whenEquals.trim() : "any";
    out.push({
      id,
      whenEquals,
      formRef: { kind, id: refId.trim() },
      neededBeforeReview: o.neededBeforeReview === true,
    });
  }
  return out;
}

const isYesNoOptions = (options: readonly string[]): boolean =>
  options.length === 2 && options[0]!.trim().toLowerCase() === "yes" && options[1]!.trim().toLowerCase() === "no";

/**
 * The answers a rule on a question of this type can wait for. Yes/No (a checkbox, or a pick of exactly
 * Yes and No) -> yes / no / any; a number -> more than 0 / any; any other pick -> each choice / any;
 * everything else can only wait for "any".
 */
export function whenOptionsForQuestionType(type: string, options: readonly string[] = []): string[] {
  if (type === "checkbox") return ["yes", "no", "any"];
  if (type === "number") return [">0", "any"];
  if (type === "select" || type === "multi_select") {
    if (isYesNoOptions(options)) return ["yes", "no", "any"];
    const choices = options.map((option) => option.trim()).filter(Boolean);
    return [...new Set(choices), "any"];
  }
  return ["any"];
}

/** How one `whenEquals` value reads in the rule row. */
export function whenOptionLabel(value: string): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  if (value === "any") return "Any answer";
  if (value === ">0") return "More than 0";
  return value;
}

function asYesNo(answer: unknown): "yes" | "no" | null {
  if (answer === true) return "yes";
  if (answer === false) return "no";
  if (typeof answer !== "string") return null;
  const text = answer.trim().toLowerCase();
  if (text === "yes" || text === "true" || text === "y") return "yes";
  if (text === "no" || text === "false" || text === "n") return "no";
  return null;
}

function isAnswered(answer: unknown): boolean {
  if (answer === null || answer === undefined || answer === false) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.some((entry) => isAnswered(entry));
  return true;
}

/** True when the applicant's answer triggers this rule. */
export function ruleMatches(rule: Pick<LinkedFormRule, "whenEquals">, answer: unknown): boolean {
  const when = rule.whenEquals.trim().toLowerCase();
  if (when === "any") return isAnswered(answer);
  if (when === ">0") {
    const value = typeof answer === "number" ? answer : Number(String(answer ?? "").replace(/[$,\s]/g, ""));
    return Number.isFinite(value) && value > 0;
  }
  if (when === "yes" || when === "no") return asYesNo(answer) === when;
  const wanted = rule.whenEquals.trim().toLowerCase();
  if (Array.isArray(answer)) return answer.some((entry) => String(entry).trim().toLowerCase() === wanted);
  if (typeof answer === "string" || typeof answer === "number") return String(answer).trim().toLowerCase() === wanted;
  return false;
}

/**
 * The rule a template's co-signer link stands for: when the applicant plans a co-signer, include that
 * co-signer form, before the application is reviewed.
 */
export function deriveCosignerLinkedFormRule(linkedCosignerApplicationTemplateId: string): LinkedFormRule {
  return {
    id: DERIVED_COSIGNER_RULE_ID,
    whenEquals: "yes",
    formRef: { kind: "application", id: linkedCosignerApplicationTemplateId },
    neededBeforeReview: true,
  };
}

/**
 * Migration on read: a template that links a co-signer form gets that link as a rule on the built-in
 * "Co-signer planned" question. Nothing is written back until the manager edits and saves (the rule then
 * rides along on the question's override). A question whose `linkedForms` was ever stored, even as an empty
 * list, is the manager's own word and is left alone.
 */
export function withDerivedCosignerRule<T extends { standardKey?: string; linkedForms?: LinkedFormRule[] }>(
  fields: readonly T[],
  linkedCosignerApplicationTemplateId: string | null | undefined,
): T[] {
  const linked = linkedCosignerApplicationTemplateId?.trim();
  if (!linked) return [...fields];
  return fields.map((field) =>
    field.standardKey === COSIGNER_QUESTION_STANDARD_KEY && field.linkedForms === undefined
      ? { ...field, linkedForms: [deriveCosignerLinkedFormRule(linked)] }
      : field,
  );
}

/** One stable string for a form reference (a dropdown value). */
export function linkedFormKey(ref: LinkedFormRef): string {
  return `${ref.kind}:${ref.id}`;
}
