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
  /**
   * The PDF's own heading text this prompt was read under (e.g. "Medical
   * Information"), when one could be confidently placed before its content.
   * Purely informational grouping metadata for manager review — the field
   * still lives in the app's own "additional" application section, since the
   * fixed wizard-step schema (`RentalApplicationSectionId`) has no slot for
   * an arbitrary manager-named section. Absent when no heading could be
   * confidently attributed (see the `heading_label_trailing` issue).
   */
  importSectionLabel?: string;
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
  if (/\b(amount|income|salary|deposit|savings)\b|\bnumber of\b|\brent amount\b/.test(prompt)) return "number";
  return "text";
}

function uniqueKey(label: string, taken: Set<string>): string {
  const base = normalize(label).replace(/\s+/g, "-").slice(0, 48) || "imported-question";
  let key = base;
  let suffix = 2;
  while (taken.has(key)) key = `${base}-${suffix++}`;
  taken.add(key);
  return key;
}

// ---------------------------------------------------------------------------
// Line classification
//
// `pdf-source.server.ts` extracts one block per visual text line. A single
// intake-form line often carries MORE than one prompt ("First Name: Middle
// Name:"), a Yes/No gate ("Can you walk independently?(Circle) Yes No
// Sometimes"), that gate's own conditional follow-up on the very next line
// ("If No or Sometimes Explain:____"), a bare section heading ("Medical
// Information"), a bare sub-group label ("List food items that you do not
// like:") whose next few short lines are its actual fields, or pure blank
// fill (a run of underscores with nothing else, reserved for handwriting).
// Every one of those needs different handling; treating every line as "one
// question, verbatim" (the previous implementation) merged unrelated prompts
// into one garbled row, never linked a gate to its own explain follow-up,
// and silently dropped every duplicate-looking line (two different people's
// "Phone Number: Email:" rows) via `continue` with no question ever created.
// ---------------------------------------------------------------------------

const BLANK_FILL_RE = /^[_\s]+$/;
const OFFICE_USE_RE = /^office\s+use\s+only\b/i;
/** "If Yes, please explain:" / "IF YES, please explain:" / "If No or Sometimes Explain:" / "If Yes, provide information:" */
const FOLLOWUP_RE = /^if\s+(yes|no(?:\s+or\s+sometimes)?)\s*,?\s*(please\s+)?(explain|provide\s+information)\s*:?\s*$/i;
/** A trailing Yes/No, Yes/No/Sometimes, or Y/N gate, optionally preceded by "(Circle)". */
const GATE_RE = /^(.+?[?])\s*(?:\(circle\)\s*)?(?:yes\s*\/?\s*no|y\s*\/\s*n)(\s+sometimes)?\.?\s*$/i;
/** A bare group label with nothing else on the line ("List Medications:", "List Food/ Beverages:"). */
const BARE_GROUP_LABEL_RE = /^([A-Z][A-Za-z0-9 /'-]{1,50}):\s*$/;
/** Short connector words a Title Case heading may still contain lowercase ("Terms of Service"). */
const HEADING_MINOR_WORDS = new Set(["of", "and", "the", "a", "an", "in", "or", "to", "for", "on"]);

/**
 * A section heading in this document is consistently rendered Title Case
 * ("Medical Information", "Resident Suitability Questionnaire"). An ordinary
 * sentence-shaped prompt with no other punctuation ("Explain how you will
 * pay rent") only capitalizes its first word — requiring every non-minor
 * word to start capitalized is what tells the two apart.
 */
function looksLikeHeadingShape(text: string): boolean {
  if (text.length < 3 || text.length > 58) return false;
  if (!/^[A-Za-z0-9 ,'&()-]+$/.test(text) || /\d{2,}/.test(text)) return false;
  const words = text.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((word) => /^[A-Z(]/.test(word) || HEADING_MINOR_WORDS.has(word.toLowerCase()));
}

function cleanGateLabel(label: string): string {
  return label.replace(/\s*\(circle\)\s*$/i, "").replace(/\?\s*$/, "").trim();
}

/**
 * Split one physical line into its distinct field-label prompts. PDF intake
 * lines are fill-in-the-blank, so everything between a label and the next
 * label (or line end) is blank space for handwriting, not an answer to keep.
 */
function splitFieldLabels(text: string): string[] {
  const cleaned = text.replace(/\(\$\)/g, " $");
  const fallback = () => {
    const whole = cleaned.replace(/[_:]+\s*(?:_{2,})?$/, "").trim();
    return whole ? [whole] : [];
  };
  const matches = [...cleaned.matchAll(/([A-Z][A-Za-z0-9 /'#().-]{0,60}?)(?::|\s\$)/g)];
  if (matches.length === 0) return fallback();
  // A genuine fill-in-the-blank line has nothing but blank/underscore/label
  // text between matches (and before the first one) — real lowercase prose
  // there means a colon landed mid-sentence (an "(Example:" aside, a
  // PDF line-wrap) rather than separating two form fields, and the whole
  // line stays one prompt instead of shredding it into a stray fragment.
  const hasProse = (segment: string) => /[a-z]{3,}/.test(segment.replace(/\([^)]*\)?/g, ""));
  if (hasProse(cleaned.slice(0, matches[0].index))) return fallback();
  for (let i = 0; i < matches.length; i += 1) {
    const afterStart = matches[i].index! + matches[i][0].length;
    const nextStart = matches[i + 1]?.index ?? cleaned.length;
    if (hasProse(cleaned.slice(afterStart, nextStart))) return fallback();
  }
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const match of matches) {
    const label = match[1].trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/** "Label: option1 / option2 / option3" — a slash-separated choice list rather than a blank to fill in. */
function matchSlashOptions(text: string): { label: string; options: string[] } | null {
  const match = text.match(/^(.+?):\s*([^?]{1,140})$/);
  if (!match || !match[2].includes("/")) return null;
  // A genuine choice list is short real words ("January / February"), never
  // a blank-fill fragment carrying its own colon or underscores (a second
  // field's label and filler that happens to contain an unrelated slash,
  // like "Probation/Parole Officer Name: ___ End Date: __/____/____").
  const options = match[2].split("/")
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= 60 && !/[_:]/.test(option) && /^[A-Za-z]/.test(option));
  if (options.length < 2 || options.length > 12) return null;
  return { label: match[1].trim(), options };
}

type PendingGate = { key: string; label: string; threeState: boolean; flaggedThreeStateOnce: boolean };
type PendingConditional = { fieldKey: string; equals: "yes" | "no" };

/**
 * Deterministically maps source-order PDF prompt blocks into editable form
 * rows. It intentionally does not invent questions from prose. Ambiguous
 * source stays visible through the PDF comparison and is always reported as
 * an issue for a manager decision — content is never silently dropped, and
 * duplicate-looking prompts (two different contacts each asking "Phone
 * Number") are each kept as their own numbered row rather than discarded.
 */
export function mapApplicationPdfImport(source: PdfImportSource): ApplicationPdfImportMapping {
  const questions: ImportedApplicationQuestion[] = [];
  const issues = [...source.issues];
  const takenKeys = new Set<string>();
  const mappedStandard = new Set<string>();
  const labelOccurrences = new Map<string, number>();

  let currentHeading: string | undefined;
  let officeUseStarted = false;
  let pendingGate: PendingGate | undefined;
  let pendingConditional: PendingConditional | undefined;
  let pendingChecklistParent: ImportedApplicationQuestion | undefined;
  let currentGroupPrefix: string | undefined;

  const labelFor = (rawLabel: string): string => {
    const withPrefix = currentGroupPrefix ? `${currentGroupPrefix} — ${rawLabel}` : rawLabel;
    const key = normalize(withPrefix);
    const seenCount = labelOccurrences.get(key) ?? 0;
    labelOccurrences.set(key, seenCount + 1);
    return seenCount === 0 ? withPrefix : `${withPrefix} (${seenCount + 1})`;
  };

  const pushRow = (
    label: string,
    type: ManagerCustomApplicationFieldType,
    options: string[],
    pageNumber: number,
    block: { start: number; end: number },
    opts: { showIf?: { fieldKey: string; equals: string }; description?: string } = {},
  ): ImportedApplicationQuestion | null => {
    // The label alone ("Email Address") often carries no third-party
    // wording — the "this is the emergency contact's" context lives in the
    // heading above it instead. Check both so a generic identity-shaped
    // sub-field under "Emergency Contact Information" never steals the
    // applicant's own standard identity slot.
    const thirdPartyIdentity = isThirdPartyIdentityQuestion(label) ||
      (Boolean(currentHeading) && /\b(name|phone|telephone|mobile|cell|email|e mail|contact)\b/.test(normalize(label)) &&
        isThirdPartyIdentityQuestion(`${currentHeading} ${label}`));
    const canonical = thirdPartyIdentity ? undefined : standardFieldForQuestion(label);
    const identityMatch = thirdPartyIdentity ? undefined : identityStandardFieldForQuestion(label);
    const standard = identityMatch ?? protectedStandardFieldForQuestion(label);
    if (thirdPartyIdentity) {
      issues.push({ pageNumber, code: "third_party_identity_requires_review", message: `Review who should answer "${label}"; it was kept as a separate question.` });
    }
    if (standard && !IDENTITY_WORDS[standard.label]) {
      issues.push({ pageNumber, code: "structural_field_order_fixed", message: `"${label}" stays in its required PropLane step so its answer can populate the lease.` });
    }
    if (!standard && canonical && canonical.section !== "additional") {
      issues.push({ pageNumber, code: "grouping_requires_review", message: `Review where "${label}" belongs in the applicant form.` });
    }
    if (standard && mappedStandard.has(standard.standardKey)) {
      if (identityMatch) {
        // The applicant-identity slot is already filled (e.g. a second
        // "Phone Number" for a spouse or emergency contact) — a second
        // real person is asking the same question, so it is kept as its
        // own custom question rather than colliding with the first mapping.
        issues.push({ pageNumber, code: "duplicate_standard_question", message: `Review repeated identity question "${label}"; kept as its own question, not merged into the applicant's own field.` });
      } else {
        // A protected structural field (property, room choice, lease dates,
        // occupant count, consent) has exactly one PropLane control — a
        // second prompt asking for the same control (e.g. a form that lists
        // "Lease start date" and "Lease end date" as two separate prompts
        // for the one combined date-range field) has nothing new to collect.
        issues.push({ pageNumber, code: "duplicate_standard_question", message: `"${label}" repeats a structural question already asked once; not added again.` });
        return null;
      }
    }
    const useStandard = standard && !mappedStandard.has(standard.standardKey) ? standard : undefined;
    const finalType = useStandard?.type ?? type;
    const finalOptions = useStandard?.options ? [...useStandard.options] : options;
    const row: ImportedApplicationQuestion = {
      id: `import-p${pageNumber}-${block.start}`,
      key: useStandard?.standardKey ?? uniqueKey(label, takenKeys),
      label,
      type: finalType,
      required: Boolean(useStandard?.required || /(?:\*|\brequired\b|\bmandatory\b)/i.test(label)),
      options: finalOptions,
      section: useStandard?.section ?? "additional",
      standardKey: useStandard?.standardKey,
      sourcePage: pageNumber,
      sourceStart: block.start,
      sourceEnd: block.end,
      mappedStandardKey: useStandard?.standardKey,
      replacesStandardKey: !useStandard && canonical ? canonical.standardKey : undefined,
      importSectionLabel: useStandard ? undefined : currentHeading,
      showIf: opts.showIf,
      description: opts.description,
    };
    if (useStandard) mappedStandard.add(useStandard.standardKey);
    questions.push(row);
    return row;
  };

  for (const page of source.pages) {
    let pendingHeadingCandidate: string | null = null;

    const settleHeadingCandidate = (followedByRealContent: boolean) => {
      if (pendingHeadingCandidate === null) return;
      const candidate = pendingHeadingCandidate;
      pendingHeadingCandidate = null;
      if (followedByRealContent) {
        currentHeading = candidate.replace(/\s*\(?continued\)?\s*$/i, "").trim();
        return;
      }
      // The candidate is immediately followed by another heading-like line,
      // blank fill, or the end of the page — this is page navigation text
      // (e.g. a 4-item tab strip), not a forward-labeling section heading,
      // or it is a TRAILING footer label for content already emitted above.
      issues.push({
        pageNumber: page.pageNumber,
        code: "heading_label_trailing",
        message: `"${candidate}" appears after its own content on page ${page.pageNumber} rather than before it. The questions immediately above may belong under this heading — review placement.`,
      });
      currentHeading = undefined;
    };

    /**
     * Does the VERY NEXT block (no gap, not even a blank-fill line) look
     * like a short colon-terminated sub-field? A real sub-field group
     * ("Meats:" / "Vegetables:" / "Other:", each carrying its own inline
     * blank-fill) always sits back to back with zero blank-only blocks in
     * between. Two standalone prompts that both happen to be short and
     * colon-terminated ("List Medications:" ... three blank lines ...
     * "List Food/ Beverages:") are NOT a group — allowing a gap here is what
     * previously let one swallow the other as an unused prefix.
     */
    const shortSubFieldFollows = (fromIndex: number): boolean => {
      const next = page.blocks[fromIndex];
      if (!next) return false;
      const peek = next.text.replace(/\s+/g, " ").trim();
      if (!peek || BLANK_FILL_RE.test(peek)) return false;
      if (GATE_RE.test(peek) || looksLikeHeadingShape(peek) || OFFICE_USE_RE.test(peek)) return false;
      const peekLabels = splitFieldLabels(peek);
      return peekLabels.length === 1 && peekLabels[0]!.length <= 30 && !peek.includes("?");
    };

    for (let blockIndex = 0; blockIndex < page.blocks.length; blockIndex += 1) {
      const block = page.blocks[blockIndex]!;
      const text = block.text.replace(/\s+/g, " ").trim();
      if (!text) continue;

      if (officeUseStarted) continue;

      // A block this long is prose, not a single prompt — keep it visible
      // through the PDF comparison and let a manager place it by hand.
      if (text.length > 300) {
        settleHeadingCandidate(false);
        issues.push({ pageNumber: page.pageNumber, code: "source_block_unmapped", message: `Review source text at page ${page.pageNumber}: "${text.slice(0, 120)}…"` });
        pendingGate = undefined;
        pendingConditional = undefined;
        currentGroupPrefix = undefined;
        continue;
      }

      if (OFFICE_USE_RE.test(text)) {
        settleHeadingCandidate(false);
        officeUseStarted = true;
        issues.push({
          pageNumber: page.pageNumber,
          code: "office_use_only_manager_field",
          message: `Page ${page.pageNumber} begins an "Office use only" block. Kept out of the applicant-facing form; add these as manager-only notes if needed.`,
        });
        continue;
      }

      if (BLANK_FILL_RE.test(text)) {
        settleHeadingCandidate(false);
        continue;
      }

      // A pending heading candidate is settled the moment we see the next
      // real (non-blank, non-office-use) line: real content confirms it was
      // a forward-labeling heading.
      if (pendingHeadingCandidate !== null) settleHeadingCandidate(true);

      // "If No or Sometimes Explain:___________" carries its own inline
      // blank-fill after the colon on the same line — strip it before
      // testing, the same way a bare "Explain:" with nothing after it does.
      const followup = text.replace(/[_]+\s*$/, "").match(FOLLOWUP_RE);
      if (followup) {
        if (!pendingGate) {
          issues.push({ pageNumber: page.pageNumber, code: "followup_without_gate", message: `Could not find the Yes/No question this follow-up ("${text}") belongs to; review page ${page.pageNumber}.` });
          continue;
        }
        const trigger: "yes" | "no" = /^if\s+no/i.test(text) ? "no" : "yes";
        if (pendingGate.threeState && trigger === "no" && !pendingGate.flaggedThreeStateOnce) {
          pendingGate.flaggedThreeStateOnce = true;
          issues.push({
            pageNumber: page.pageNumber,
            code: "conditional_covers_one_answer_only",
            message: `"${pendingGate.label}" offers Yes/No/Sometimes, but a question can only reveal its follow-up for one exact answer. The follow-up is set to show on "No" — confirm whether "Sometimes" should also reveal it.`,
          });
        }
        if (/provide\s+information/i.test(text)) {
          // The next several field-label lines are the actual "if yes"
          // content (e.g. Probation/Parole Officer Name, End Date, Contact
          // #, CDC #) rather than one free-text explanation.
          pendingConditional = { fieldKey: pendingGate.key, equals: trigger };
        } else {
          pushRow(`${pendingGate.label} — explain`, "long_text", [], page.pageNumber, block, {
            showIf: { fieldKey: pendingGate.key, equals: trigger },
          });
          pendingConditional = undefined;
        }
        continue;
      }

      // A pending checklist continuation (a prior prompt ending "(Circle)" /
      // "listed below" with no options of its own) takes priority over
      // heading classification — a bare word list like "Fever Dry Cough
      // Flu-like Symptoms" has the exact same shape as a section heading.
      if (pendingChecklistParent && !text.includes(":") && !text.includes("_") && /^[A-Z]/.test(text) && text.split(" ").length >= 2) {
        pendingChecklistParent.description = pendingChecklistParent.description
          ? `${pendingChecklistParent.description} ${text}`
          : `Source lists: ${text}`;
        issues.push({ pageNumber: page.pageNumber, code: "checklist_options_uncertain", message: `Review the choices for "${pendingChecklistParent.label}" against the original PDF; kept as free text with the source list noted.` });
        pendingChecklistParent = undefined;
        continue;
      }
      pendingChecklistParent = undefined;

      if (looksLikeHeadingShape(text) && !GATE_RE.test(text) && !BARE_GROUP_LABEL_RE.test(text)) {
        pendingHeadingCandidate = text;
        pendingGate = undefined;
        pendingConditional = undefined;
        currentGroupPrefix = undefined;
        continue;
      }

      const gateMatch = text.match(GATE_RE);
      if (gateMatch) {
        const label = labelFor(cleanGateLabel(gateMatch[1]));
        const threeState = Boolean(gateMatch[2]);
        const options = threeState ? ["Yes", "No", "Sometimes"] : ["Yes", "No"];
        const row = pushRow(label, threeState ? "select" : "yes_no", options, page.pageNumber, block);
        pendingGate = row ? { key: row.key, label: row.label, threeState, flaggedThreeStateOnce: false } : undefined;
        pendingConditional = undefined;
        currentGroupPrefix = undefined;
        continue;
      }

      const bareGroup = text.match(BARE_GROUP_LABEL_RE);
      // A group-prefix line is a short bare label ("List Medications:",
      // "Meats:") meant to caption the next few short sub-field lines — not
      // a full sentence-shaped question that happens to end in a colon. Only
      // treated as a group header when a genuine short sub-field actually
      // follows; otherwise it is its own single-answer prompt ("List
      // Activities you enjoy doing:" has nothing short after it).
      if (bareGroup && bareGroup[1].length <= 40 && !/^(do you|are you|can you|have you|will you)\b/i.test(bareGroup[1]) &&
        shortSubFieldFollows(blockIndex + 1)) {
        currentGroupPrefix = bareGroup[1].trim();
        pendingGate = undefined;
        continue;
      }

      const slashOptions = matchSlashOptions(text);
      if (slashOptions) {
        const label = labelFor(slashOptions.label);
        const yesNo = slashOptions.options.length === 2 && slashOptions.options.every((option) => /^(yes|no)$/i.test(option));
        pushRow(label, yesNo ? "yes_no" : "select", slashOptions.options, page.pageNumber, block, pendingConditional ? { showIf: pendingConditional } : {});
        pendingGate = undefined;
        currentGroupPrefix = undefined;
        continue;
      }

      const labels = splitFieldLabels(text);
      if (labels.length === 0) {
        issues.push({ pageNumber: page.pageNumber, code: "source_block_unmapped", message: `Review source text at page ${page.pageNumber}: "${text}"` });
        pendingConditional = undefined;
        currentGroupPrefix = undefined;
        continue;
      }
      // A group prefix only applies to a short, single, sub-field-shaped
      // line (the "Meats:" under "List food items you do not like:" case) —
      // a full-sentence question that happens to share the same line shape
      // must not inherit and keep re-broadcasting a stale prefix.
      const isSubFieldLine = labels.length === 1 && labels[0].length <= 30 && !text.includes("?");
      if (!isSubFieldLine) currentGroupPrefix = undefined;
      for (const rawLabel of labels) {
        const label = labelFor(rawLabel);
        const endsInCircle = /\(circle\)\s*$/i.test(text) || /listed below/i.test(text);
        const row = pushRow(
          label,
          typeForQuestion(label),
          [],
          page.pageNumber,
          block,
          pendingConditional ? { showIf: pendingConditional } : {},
        );
        if (endsInCircle && labels.length === 1 && row) pendingChecklistParent = row;
      }
      pendingGate = undefined;
      // A field-label line (not itself a follow-up marker) ends a
      // "provide information" conditional scope once we've attached it to
      // at least one row, EXCEPT this exact line — later sibling lines like
      // "Probation/Parole Contact #: … CDC #:" still belong to it. Scope
      // ends at the next gate, heading, or explicit follow-up instead.
    }

    settleHeadingCandidate(false);

    // PDF AcroForm widgets carry their own label/value/options independent
    // of the page's visible text stream — merge into a text-block row that
    // already asked the same question (a fillable field's choices filling
    // in a blank the page text only rendered as a label), otherwise add it
    // as its own question.
    for (const formField of page.formFields ?? []) {
      const label = formField.name.replace(/\s+/g, " ").trim();
      if (!label) {
        issues.push({ pageNumber: page.pageNumber, code: "form_field_label_uncertain", message: "A PDF form field has no readable label. Review the original page." });
        continue;
      }
      const promptKey = normalize(label);
      const options = formField.options.map((option) => option.trim()).filter(Boolean);
      if (formField.options.length > 0 && options.length < 2) {
        issues.push({ pageNumber: page.pageNumber, code: "form_field_options_uncertain", message: `Review the choices for "${label}" against the original PDF.` });
      }
      const existing = questions.find((question) => normalize(question.label) === promptKey);
      if (existing) {
        if (options.length > 1 && existing.options.length === 0) {
          const yesNo = options.length === 2 && options.every((option) => /^(yes|no)$/i.test(option));
          existing.options = options;
          existing.type = yesNo ? "yes_no" : "select";
          existing.required = existing.required || formField.required;
        }
        continue;
      }
      const yesNo = options.length === 2 && options.every((option) => /^(yes|no)$/i.test(option));
      const type: ManagerCustomApplicationFieldType = options.length > 1 ? (yesNo ? "yes_no" : "select") : typeForQuestion(label);
      const row = pushRow(labelFor(label), type, options, page.pageNumber, { start: -1, end: -1 });
      if (row) row.required = row.required || formField.required;
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
      description: question.description,
      showIf: question.showIf,
    })),
    applicationConfigMode: "custom",
    questionDisplayOrder: mapping.questions.map((question) => question.id),
  };
}
