/** Manager-defined application questions — applicant answer helpers shared by the wizard, validation, review, and document builders. */

import {
  listingUsesStandardApplication,
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
  type ManagerCustomApplicationFieldType,
} from "@/lib/manager-listing-submission";
import { isLegitimateEmail } from "@/lib/email-address";
import { isCompletePhoneNumber } from "@/lib/phone-number-field";
import { applicationWizardStepForSection, RENTAL_APPLICATION_SECTIONS } from "./application-sections";
import type { ApplicationPhotoAttachment, RentalCustomFieldAnswer } from "./types";

/** Error-map key for a custom question (RentalWizardErrors is a flat string map). */
export function customFieldErrorKey(fieldKey: string): string {
  return `custom:${fieldKey}`;
}

/**
 * Custom questions that apply to applicants for a listing; [] for listings without any
 * and for properties set to the standard Axis application.
 */
export function listingCustomApplicationFields(
  sub: { customApplicationFields?: unknown; applicationConfigMode?: unknown } | null | undefined,
): ManagerCustomApplicationField[] {
  if (listingUsesStandardApplication(sub)) return [];
  return normalizeCustomApplicationFields(sub?.customApplicationFields).filter((f) => !f.standardKey);
}

/** Custom questions asked on a given applicant wizard step (section-tagged; untagged → Additional details). */
export function customFieldsForWizardStep(
  fields: ManagerCustomApplicationField[],
  step: number,
): ManagerCustomApplicationField[] {
  return fields.filter((f) => applicationWizardStepForSection(f.section) === step);
}

/** Manager-defined question types answered with an uploaded file (attachment metadata, never bytes). */
export function isFileCustomFieldType(type: ManagerCustomApplicationFieldType): boolean {
  return type === "file" || type === "photos";
}

/**
 * Decode a `file`/`photos` custom question answer. The answer's `value` stays a
 * `string` (like every other custom-field answer, so it flows through the
 * existing autosave path) but holds `JSON.stringify(attachment)` — this parses
 * it back, or returns null for "" / malformed / bytes-less JSON so a corrupt or
 * legacy value never renders as a broken attachment.
 */
export function parseCustomFieldAttachment(value: string): ApplicationPhotoAttachment | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { storagePath?: unknown }).storagePath === "string" &&
      (parsed as { storagePath: string }).storagePath.trim().length > 0
    ) {
      return parsed as ApplicationPhotoAttachment;
    }
    return null;
  } catch {
    return null;
  }
}

/** Encode an attachment (or its absence) as the custom question answer's string value. */
export function encodeCustomFieldAttachment(attachment: ApplicationPhotoAttachment | null): string {
  return attachment ? JSON.stringify(attachment) : "";
}

/**
 * Decode a `multi_select` custom question answer. The answer's `value` stays a
 * `string` (like every other custom-field answer) but holds
 * `JSON.stringify(string[])` — this parses it back. Tolerates "" (→ []), a
 * value that parses to something other than an array (→ [], e.g. legacy `"0"`
 * or a stray object), and a value that fails to parse as JSON at all — that
 * covers both truly malformed JSON and a legacy plain-string answer from
 * before `multi_select` existed, and either way a non-empty string survives
 * as a single-item selection ([thatString]) rather than throwing or vanishing.
 */
export function parseMultiSelectAnswer(value: string): string[] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [trimmed];
  }
}

/** Encode a `multi_select` answer's selections as the answer's string value. */
export function encodeMultiSelectAnswer(values: string[]): string {
  return JSON.stringify(values.filter((v) => typeof v === "string" && v.length > 0));
}

export function customFieldAnswerValue(
  answers: RentalCustomFieldAnswer[] | undefined,
  fieldKey: string,
): string {
  return answers?.find((a) => a.key === fieldKey)?.value ?? "";
}

/**
 * Set one answer, snapshotting the question's label/type/section alongside the
 * value. Keeps answer order aligned with the question order the applicant saw.
 */
export function upsertCustomFieldAnswer(
  answers: RentalCustomFieldAnswer[],
  field: ManagerCustomApplicationField,
  value: string,
): RentalCustomFieldAnswer[] {
  const entry: RentalCustomFieldAnswer = {
    key: field.key,
    label: field.label,
    type: field.type,
    section: field.section,
    value,
  };
  const idx = answers.findIndex((a) => a.key === field.key);
  if (idx === -1) return [...answers, entry];
  return answers.map((a, i) => (i === idx ? entry : a));
}

/** Required/format errors for the listing's custom questions, keyed by customFieldErrorKey. */
export function validateCustomFieldAnswers(
  fields: ManagerCustomApplicationField[],
  answers: RentalCustomFieldAnswer[] | undefined,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = customFieldAnswerValue(answers, field.key).trim();
    if (field.type === "checkbox") {
      if (field.required && value !== "yes") {
        errors[customFieldErrorKey(field.key)] = "This box must be checked to continue.";
      }
      continue;
    }
    if (field.type === "yes_no") {
      if (field.required && value !== "yes" && value !== "no") {
        errors[customFieldErrorKey(field.key)] = `${field.label} is required.`;
      }
      continue;
    }
    if (field.type === "multi_select") {
      // The raw string value is JSON (often "[]"), never blank for a "nothing
      // picked" answer, so required-ness has to check the decoded selections
      // rather than the generic `if (!value)` below.
      if (field.required && parseMultiSelectAnswer(customFieldAnswerValue(answers, field.key)).length === 0) {
        errors[customFieldErrorKey(field.key)] = `${field.label} is required.`;
      }
      continue;
    }
    if (isFileCustomFieldType(field.type)) {
      const attached = parseCustomFieldAttachment(customFieldAnswerValue(answers, field.key));
      if (field.required && !attached) {
        errors[customFieldErrorKey(field.key)] = `${field.label} is required.`;
      }
      continue;
    }
    if (!value) {
      if (field.required) {
        errors[customFieldErrorKey(field.key)] = `${field.label} is required.`;
      }
      continue;
    }
    if (field.type === "number") {
      const n = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(n)) {
        errors[customFieldErrorKey(field.key)] = "Enter a valid number.";
      }
    }
    if (field.type === "currency") {
      const n = Number(value.replace(/[$,]/g, ""));
      if (!Number.isFinite(n)) {
        errors[customFieldErrorKey(field.key)] = "Enter a valid amount.";
      }
    }
    if (field.type === "email" && !isLegitimateEmail(value)) {
      errors[customFieldErrorKey(field.key)] = "Enter a valid email address.";
    }
    if (field.type === "phone" && !isCompletePhoneNumber(value)) {
      errors[customFieldErrorKey(field.key)] = "Enter a valid phone number.";
    }
    if (field.type === "select" && field.options.length > 0 && !field.options.includes(value)) {
      errors[customFieldErrorKey(field.key)] = "Choose one of the listed options.";
    }
  }
  return errors;
}

/**
 * Human-readable answer for review screens and the application document ("" when
 * unanswered). A file/photos answer's raw value is `JSON.stringify(attachment)` —
 * this must NEVER surface that JSON (the manager application PDF/HTML print this
 * result verbatim), so it always resolves to just the file name.
 */
export function formatCustomFieldAnswerDisplay(answer: RentalCustomFieldAnswer): string {
  const value = String(answer.value ?? "").trim();
  if (answer.type === "checkbox") return value === "yes" ? "Yes" : value === "no" || !value ? "No" : value;
  if (answer.type === "yes_no") return value === "yes" ? "Yes" : value === "no" ? "No" : value;
  if (answer.type === "multi_select") return parseMultiSelectAnswer(value).join(", ");
  if (answer.type === "currency") {
    if (!value) return "";
    const n = Number(value.replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) return value;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  }
  if (isFileCustomFieldType(answer.type)) {
    return parseCustomFieldAttachment(value)?.fileName ?? "";
  }
  return value;
}

/** Stored answers worth showing (skips blank non-checkbox answers). */
export function displayableCustomFieldAnswers(
  answers: RentalCustomFieldAnswer[] | undefined,
): RentalCustomFieldAnswer[] {
  if (!Array.isArray(answers)) return [];
  return answers.filter(
    (a) => a && typeof a.key === "string" && typeof a.label === "string" && a.label.trim() && (a.type === "checkbox" || String(a.value ?? "").trim()),
  );
}

/** Section id used for a displayable custom answer that has one; null groups it as sectionless. */
function knownSectionIdOrNull(answer: RentalCustomFieldAnswer): string | null {
  const section = answer.section;
  if (!section) return null;
  return RENTAL_APPLICATION_SECTIONS.some((s) => s.id === section) ? section : null;
}

/**
 * Custom answers grouped by the section that asked them, for section-headed
 * review UI. Groups follow {@link RENTAL_APPLICATION_SECTIONS} order; an
 * answer stored before `section` existed, or tagged with a section id that no
 * longer exists, is never dropped — it lands in a trailing "Other questions"
 * group instead of throwing or vanishing. Uses
 * {@link displayableCustomFieldAnswers} first so blank answers stay filtered
 * exactly as the flat list did.
 */
export function groupCustomFieldAnswersBySection(
  answers: RentalCustomFieldAnswer[] | undefined,
): Array<{ sectionId: string | null; title: string; answers: RentalCustomFieldAnswer[] }> {
  const displayable = displayableCustomFieldAnswers(answers);
  if (displayable.length === 0) return [];

  const bySection = new Map<string, RentalCustomFieldAnswer[]>();
  const sectionless: RentalCustomFieldAnswer[] = [];
  for (const answer of displayable) {
    const sectionId = knownSectionIdOrNull(answer);
    if (sectionId === null) {
      sectionless.push(answer);
      continue;
    }
    const bucket = bySection.get(sectionId);
    if (bucket) bucket.push(answer);
    else bySection.set(sectionId, [answer]);
  }

  const groups: Array<{ sectionId: string | null; title: string; answers: RentalCustomFieldAnswer[] }> = [];
  for (const section of RENTAL_APPLICATION_SECTIONS) {
    const bucket = bySection.get(section.id);
    if (bucket && bucket.length > 0) groups.push({ sectionId: section.id, title: section.title, answers: bucket });
  }
  if (sectionless.length > 0) groups.push({ sectionId: null, title: "Other questions", answers: sectionless });
  return groups;
}
