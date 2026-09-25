import type { ManagerCustomApplicationField, ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import type { PdfImportSource } from "@/lib/pdf-import/pdf-source.server";
import {
  STANDARD_APPLICATION_FIELD_CATALOG,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";

export type ImportedApplicationQuestion = ManagerCustomApplicationField & {
  sourcePage: number;
  sourceStart: number;
  sourceEnd: number;
  mappedStandardKey?: string;
  /** Canonical prompt replaced by this source-preserving custom row. */
  replacesStandardKey?: string;
};

export type ApplicationPdfImportMapping = {
  questions: ImportedApplicationQuestion[];
  issues: Array<{ pageNumber: number | null; code: string; message: string }>;
};

const IDENTITY_WORDS: Record<string, readonly string[]> = {
  "Full legal name": ["full legal name", "applicant full name", "applicant name", "legal name", "full name"],
  Phone: ["phone", "phone number", "telephone", "telephone number", "mobile number", "cell number", "applicant phone", "applicant telephone", "applicant mobile number"],
  Email: ["email", "e-mail", "email address", "applicant email", "applicant email address"],
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function standardFieldForQuestion(label: string) {
  const prompt = normalize(label).replace(/\b(required|mandatory)\b/g, "").trim();
  return STANDARD_APPLICATION_FIELD_CATALOG.find((field) => {
    const canonical = normalize(field.label);
    if (prompt === canonical || prompt.startsWith(`${canonical} `)) return true;
    return (IDENTITY_WORDS[field.label] ?? []).some((word) => prompt === normalize(word));
  });
}

function identityStandardFieldForQuestion(label: string) {
  const prompt = normalize(label).replace(/\b(required|mandatory)\b/g, "").trim();
  // Subject qualifiers take precedence over familiar identity wording. The
  // applicant's form must never collect a landlord's or emergency contact's
  // details into the applicant identity fields.
  if (/\b(emergency contact|current landlord|former landlord|landlord|employer|reference|co applicant|cosigner|co signer|household member|spouse|partner|parent|guarantor|roommate|tenant)\b/.test(prompt)) {
    return undefined;
  }
  const applicantQualified = prompt
    .replace(/\b(?:of|for)\s+applicant\b/g, " ")
    .replace(/\bapplicant s?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return STANDARD_APPLICATION_FIELD_CATALOG.find((field) => {
    if (!IDENTITY_WORDS[field.label]) return false;
    const canonical = normalize(field.label);
    const aliases = IDENTITY_WORDS[field.label]!.map(normalize);
    return prompt === canonical || aliases.includes(prompt) ||
      (applicantQualified !== prompt && (applicantQualified === canonical || aliases.includes(applicantQualified)));
  });
}

function isThirdPartyIdentityQuestion(label: string): boolean {
  const prompt = normalize(label);
  const asksForIdentity = /\b(name|phone|telephone|mobile|cell|email|e mail|contact information)\b/.test(prompt);
  return asksForIdentity && /\b(emergency contact|current landlord|former landlord|landlord|employer|reference|co applicant|cosigner|co signer|household member|spouse|partner|parent|guarantor|roommate|tenant)\b/.test(prompt);
}

function protectedStandardFieldForQuestion(label: string) {
  const prompt = normalize(label);
  const alias = /^(room choice|room preference|preferred room)/.test(prompt) ? "Room choices (1st – 3rd)"
    : /^(lease start|lease end|move in date|move out date)/.test(prompt) ? "Lease start & end dates"
    : undefined;
  const standard = alias
    ? STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === alias)
    : standardFieldForQuestion(label);
  if (!standard) return undefined;
  // These values feed placement, capacity, screening authorization, pricing,
  // and lease generation. A custom answer cannot replace their typed fields.
  return standard.section === "household" || standard.section === "property" ||
    standard.section === "consent" || standard.label === "Number of occupants"
    ? standard
    : undefined;
}

function typeForQuestion(label: string): ManagerCustomApplicationFieldType {
  const prompt = normalize(label);
  if (/\b(upload|attach|attachment|provide a copy|submit a copy)\b/.test(prompt)) {
    return /\b(photo|photos|pictures|images)\b/.test(prompt) ? "photos" : "file";
  }
  if (/\b(yes no|yes or no)\b/.test(prompt)) return "yes_no";
  if (/\b(date|birth)\b/.test(prompt)) return "date";
  if (/\b(amount|income|salary)\b|\bnumber of\b|\brent amount\b/.test(prompt)) return "number";
  return "text";
}

function sourceQuestionLabel(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 300) return null;
  // A conservative import only treats a prompt-shaped source block as a
  // question. Other source content remains visible through the PDF comparison.
  if (!/[?:_*]{1,}/.test(cleaned) && !/^(full |current |previous |employer|reference|date |phone|email|do you |explain |describe |parking |applicant |landlord |emergency |contact )/i.test(cleaned)) {
    return null;
  }
  return cleaned.replace(/[_:]+\s*(?:_{2,})?$/, "").trim() || null;
}

function sourceChoiceOptions(label: string): { label: string; options: string[]; uncertain: boolean } {
  const match = label.match(/^(.+?)(?:\?|:)\s*([^?]{1,140})$/);
  if (!match || !match[2].includes("/")) return { label, options: [], uncertain: label.includes("/") };
  const options = match[2]
    .split("/")
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= 60);
  if (options.length < 2 || options.length > 12) return { label, options: [], uncertain: true };
  return { label: match[1].trim(), options, uncertain: false };
}

function uniqueKey(label: string, taken: Set<string>): string {
  const base = normalize(label).replace(/\s+/g, "-").slice(0, 48) || "imported-question";
  let key = base;
  let suffix = 2;
  while (taken.has(key)) key = `${base}-${suffix++}`;
  taken.add(key);
  return key;
}

/**
 * Deterministically maps source-order PDF prompt blocks into editable form rows.
 * It intentionally does not invent questions from prose. Ambiguous source stays
 * in the original comparison pane and is reported for a manager decision.
 */
export function mapApplicationPdfImport(source: PdfImportSource): ApplicationPdfImportMapping {
  const questions: ImportedApplicationQuestion[] = [];
  const issues = [...source.issues];
  const takenKeys = new Set<string>();
  const mappedStandard = new Set<string>();
  const seenPrompts = new Set<string>();

  for (const page of source.pages) {
    for (const block of page.blocks) {
      const label = sourceQuestionLabel(block.text);
      if (!label) {
        if (block.text.trim()) issues.push({ pageNumber: page.pageNumber, code: "source_block_unmapped", message: `Review source text at page ${page.pageNumber}, characters ${block.start}-${block.end}.` });
        continue;
      }
      const choice = sourceChoiceOptions(label);
      const promptKey = normalize(choice.label);
      if (seenPrompts.has(promptKey)) {
        issues.push({ pageNumber: page.pageNumber, code: "repeated_question_requires_review", message: `Review repeated source question “${label}”.` });
        continue;
      }
      seenPrompts.add(promptKey);
      if (choice.uncertain) {
        issues.push({ pageNumber: page.pageNumber, code: "choice_options_uncertain", message: `Review the choices in “${label}” against the original PDF.` });
      }
      const thirdPartyIdentity = isThirdPartyIdentityQuestion(choice.label);
      const canonical = thirdPartyIdentity ? undefined : standardFieldForQuestion(choice.label);
      const standard = identityStandardFieldForQuestion(choice.label) ?? protectedStandardFieldForQuestion(choice.label);
      if (thirdPartyIdentity) {
        issues.push({ pageNumber: page.pageNumber, code: "third_party_identity_requires_review", message: `Review who should answer “${choice.label}”; it was kept as a separate question.` });
      }
      if (standard && !IDENTITY_WORDS[standard.label]) {
        issues.push({ pageNumber: page.pageNumber, code: "structural_field_order_fixed", message: `“${choice.label}” stays in its required PropLane step so its answer can populate the lease.` });
      }
      if (!standard && canonical && canonical.section !== "additional") {
        issues.push({ pageNumber: page.pageNumber, code: "grouping_requires_review", message: `Review where “${choice.label}” belongs in the applicant form.` });
      }
      if (standard && mappedStandard.has(standard.standardKey)) {
        issues.push({ pageNumber: page.pageNumber, code: "duplicate_standard_question", message: `Review repeated identity or structural question “${label}”.` });
        continue;
      }
      const yesNo = choice.options.length === 2 && choice.options.every((option) => /^(yes|no)$/i.test(option));
      const type = standard?.type ?? (choice.options.length > 0 ? (yesNo ? "yes_no" : "select") : typeForQuestion(choice.label));
      const row: ImportedApplicationQuestion = {
        id: `import-p${page.pageNumber}-${block.start}`,
        key: standard?.standardKey ?? uniqueKey(choice.label, takenKeys),
        label: choice.label,
        type,
        required: Boolean(standard?.required || /(?:\*|\brequired\b|\bmandatory\b)/i.test(label)),
        options: standard?.options ? [...standard.options] : choice.options,
        // Keep imported nonidentity prompts in one source-ordered step. A
        // manager can regroup them after comparing the original; guessing a
        // catalog section here would silently reorder the live form.
        section: standard?.section ?? "additional",
        standardKey: standard?.standardKey,
        sourcePage: page.pageNumber,
        sourceStart: block.start,
        sourceEnd: block.end,
        mappedStandardKey: standard?.standardKey,
        replacesStandardKey: !standard && canonical ? canonical.standardKey : undefined,
      };
      if (standard) mappedStandard.add(standard.standardKey);
      questions.push(row);
    }
    for (const formField of page.formFields ?? []) {
      const label = formField.name.replace(/\s+/g, " ").trim();
      if (!label) {
        issues.push({ pageNumber: page.pageNumber, code: "form_field_label_uncertain", message: "A PDF form field has no readable label. Review the original page." });
        continue;
      }
      const promptKey = normalize(label);
      const options = formField.options.map((option) => option.trim()).filter(Boolean);
      if (formField.options.length > 0 && options.length < 2) {
        issues.push({ pageNumber: page.pageNumber, code: "form_field_options_uncertain", message: `Review the choices for “${label}” against the original PDF.` });
      }
      if (seenPrompts.has(promptKey)) {
        const existing = questions.find((question) => normalize(question.label) === promptKey);
        if (existing && options.length > 1 && existing.options.length === 0) {
          const yesNo = options.length === 2 && options.every((option) => /^(yes|no)$/i.test(option));
          existing.options = options;
          existing.type = yesNo ? "yes_no" : "select";
          existing.required = existing.required || formField.required;
        } else if (!existing) {
          issues.push({ pageNumber: page.pageNumber, code: "form_field_duplicate_uncertain", message: `Review repeated PDF field “${label}”.` });
        }
        continue;
      }
      seenPrompts.add(promptKey);
      const thirdPartyIdentity = isThirdPartyIdentityQuestion(label);
      const canonical = thirdPartyIdentity ? undefined : standardFieldForQuestion(label);
      const standard = identityStandardFieldForQuestion(label) ?? protectedStandardFieldForQuestion(label);
      if (thirdPartyIdentity) {
        issues.push({ pageNumber: page.pageNumber, code: "third_party_identity_requires_review", message: `Review who should answer “${label}”; it was kept as a separate question.` });
      }
      if (standard && !IDENTITY_WORDS[standard.label]) {
        issues.push({ pageNumber: page.pageNumber, code: "structural_field_order_fixed", message: `“${label}” stays in its required PropLane step so its answer can populate the lease.` });
      }
      if (!standard && canonical && canonical.section !== "additional") {
        issues.push({ pageNumber: page.pageNumber, code: "grouping_requires_review", message: `Review where “${label}” belongs in the applicant form.` });
      }
      if (standard && mappedStandard.has(standard.standardKey)) {
        issues.push({ pageNumber: page.pageNumber, code: "duplicate_standard_question", message: `Review repeated PDF field “${label}”.` });
        continue;
      }
      const yesNo = options.length === 2 && options.every((option) => /^(yes|no)$/i.test(option));
      const type = standard?.type ?? (options.length > 1 ? (yesNo ? "yes_no" : "select") : typeForQuestion(label));
      if (standard) mappedStandard.add(standard.standardKey);
      questions.push({
        id: `import-p${page.pageNumber}-field-${questions.length + 1}`,
        key: standard?.standardKey ?? uniqueKey(label, takenKeys),
        label,
        type,
        required: standard?.required ?? formField.required,
        options: standard?.options ? [...standard.options] : options,
        section: standard?.section ?? "additional",
        standardKey: standard?.standardKey,
        sourcePage: page.pageNumber,
        sourceStart: -1,
        sourceEnd: -1,
        mappedStandardKey: standard?.standardKey,
        replacesStandardKey: !standard && canonical ? canonical.standardKey : undefined,
      });
    }
    for (const issue of page.issues) {
      issues.push({ pageNumber: page.pageNumber, code: "page_unresolved", message: issue });
    }
  }
  return { questions, issues };
}

/** Turns an import mapping into a draft config without publishing it. */
export function applicationImportMappingToDraft(mapping: ApplicationPdfImportMapping): ApplicationConfigSlice {
  return {
    disabledStandardApplicationKeys: [...new Set(
      mapping.questions.flatMap((question) => question.replacesStandardKey ? [question.replacesStandardKey] : []),
    )],
    customApplicationFields: mapping.questions.map((question) => ({
      id: question.id,
      key: question.key,
      label: question.label,
      type: question.type,
      required: question.required,
      options: [...question.options],
      section: question.section,
      standardKey: question.standardKey,
    })),
    applicationConfigMode: "custom",
    questionDisplayOrder: mapping.questions.map((question) => question.id),
  };
}
