/**
 * Pure helpers for the move-in form UI: answer shape conversion, question visibility and
 * progress (the resident fill flow), section/question mutation (the builder), and the plain
 * wording a property row draws. No React and no I/O, so the editor, the live preview and the
 * resident screen all read one set of rules and a unit test can pin them.
 */
import { isLegitimateEmail } from "@/lib/email-address";
import { isCompletePhoneNumber } from "@/lib/phone-number-field";
import {
  encodeMultiSelectAnswer,
  parseMultiSelectAnswer,
} from "@/lib/rental-application/custom-fields";
import type {
  MoveInFormAnswer,
  MoveInFormAudience,
  MoveInFormDueRule,
  MoveInFormQuestion,
  MoveInFormSummary,
  MoveInFormTemplate,
  MoveInFormTrigger,
} from "@/lib/move-in-forms/types";

/* ───────────────────────────── answers ───────────────────────────── */

export type MoveInAnswerMap = Record<string, MoveInFormAnswer>;

/** A copy of `record` without `key` (keeps the destructure-and-discard idiom out of call sites). */
export function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function answersToMap(answers: readonly MoveInFormAnswer[] | null | undefined): MoveInAnswerMap {
  const map: MoveInAnswerMap = {};
  for (const answer of answers ?? []) map[answer.key] = answer;
  return map;
}

/**
 * Answers in question order, only the ones that carry something. Hidden questions never leave the device.
 * A draft also holds back an answer that is mid-typing (half a phone number), because the server checks
 * the format of every answer it is sent and one half-typed value would refuse the whole draft.
 */
export function mapToAnswers(
  questions: readonly MoveInFormQuestion[],
  map: MoveInAnswerMap,
  options: { draft?: boolean } = {},
): MoveInFormAnswer[] {
  const visible = new Set(visibleMoveInQuestions(questions, map).map((q) => q.key));
  return questions
    .filter((q) => visible.has(q.key))
    .filter((q) => !options.draft || !answerFormatProblem(q, map[q.key]))
    .map((q) => map[q.key])
    .filter((answer): answer is MoveInFormAnswer => Boolean(answer) && isAnswerFilled(answer));
}

/** The same format rules the server applies to a typed answer; null when the answer is fine or empty. */
export function answerFormatProblem(question: MoveInFormQuestion, answer: MoveInFormAnswer | undefined): string | null {
  if (!answer || !("value" in answer)) return null;
  const text = answerToFieldString(question, answer).trim();
  if (!text) return null;
  switch (question.type) {
    case "phone":
      return isCompletePhoneNumber(text) ? null : "Enter a complete phone number.";
    case "email":
      return isLegitimateEmail(text) ? null : "Enter a valid email address.";
    case "number":
    case "currency":
      return Number.isFinite(Number(text)) ? null : "Enter a number.";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime()) ? null : "Enter a valid date.";
    case "select":
      return question.options.includes(text) ? null : "Choose one of the options.";
    case "long_text":
      return text.length > 5000 ? "Keep this under 5,000 characters." : null;
    case "multi_select":
    case "yes_no":
    case "checkbox":
      return null;
    default:
      return text.length > 500 ? "Keep this under 500 characters." : null;
  }
}

/** The first visible answer whose format the server would refuse, so a submit can stop on it. */
export function firstFormatProblem(
  questions: readonly MoveInFormQuestion[],
  map: MoveInAnswerMap,
): { question: MoveInFormQuestion; message: string } | null {
  for (const question of visibleMoveInQuestions(questions, map)) {
    const message = answerFormatProblem(question, map[question.key]);
    if (message) return { question, message };
  }
  return null;
}

function isAnswerFilled(answer: MoveInFormAnswer): boolean {
  if ("files" in answer) return answer.files.length > 0;
  if ("signature" in answer) return Boolean(answer.signature.storagePath);
  const value = answer.value;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** The single string the shared question renderer works in ("yes" / "no" / "yes" for a ticked box / JSON for several). */
export function answerToFieldString(question: Pick<MoveInFormQuestion, "type">, answer: MoveInFormAnswer | undefined): string {
  if (!answer || !("value" in answer)) return "";
  const value = answer.value;
  if (value === null || value === undefined) return "";
  if (question.type === "multi_select") {
    return Array.isArray(value) ? encodeMultiSelectAnswer(value) : parseMultiSelectAnswer(String(value)).length ? encodeMultiSelectAnswer(parseMultiSelectAnswer(String(value))) : "";
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function fieldStringToAnswer(question: Pick<MoveInFormQuestion, "type" | "key">, raw: string): MoveInFormAnswer | null {
  const text = raw ?? "";
  if (!text.trim()) return null;
  if (question.type === "multi_select") {
    const picked = parseMultiSelectAnswer(text);
    return picked.length ? { key: question.key, value: picked } : null;
  }
  if (question.type === "number" || question.type === "currency") {
    // "$1,200.50" is a fine thing to type; the stored answer is the bare number the server expects.
    const bare = text.replace(/[$,\s]/g, "");
    return { key: question.key, value: Number.isFinite(Number(bare)) && bare ? bare : text };
  }
  return { key: question.key, value: text };
}

/** Whether a question has what it asks for (a ticked box, a photo, a signature, a non-blank text). */
export function isMoveInQuestionAnswered(question: MoveInFormQuestion, answer: MoveInFormAnswer | undefined): boolean {
  if (!answer || !isAnswerFilled(answer)) return false;
  if (question.type === "checkbox") return "value" in answer && answerToFieldString(question, answer) === "yes";
  if (question.type === "yes_no") {
    const text = answerToFieldString(question, answer);
    return text === "yes" || text === "no";
  }
  return true;
}

/** `showIf` is the application's rule: shown only while the named sibling holds exactly that answer. */
export function isMoveInQuestionVisible(question: MoveInFormQuestion, map: MoveInAnswerMap, all: readonly MoveInFormQuestion[]): boolean {
  const condition = question.showIf;
  if (!condition?.fieldKey) return true;
  const source = all.find((q) => q.key === condition.fieldKey);
  if (!source) return true;
  // A question hidden by its own condition cannot gate another.
  if (!isMoveInQuestionVisible(source, map, all.filter((q) => q.key !== question.key))) return false;
  return answerToFieldString(source, map[condition.fieldKey]) === condition.equals;
}

export function visibleMoveInQuestions(questions: readonly MoveInFormQuestion[], map: MoveInAnswerMap): MoveInFormQuestion[] {
  return questions.filter((q) => isMoveInQuestionVisible(q, map, questions));
}

export type MoveInFormProgress = {
  total: number;
  answered: number;
  /** 0..1 — what the progress bar draws. */
  ratio: number;
  /** Visible required questions still empty. */
  missing: MoveInFormQuestion[];
  /** Index (among visible questions) of the first unanswered one; the last when everything is answered. */
  resumeIndex: number;
};

export function moveInFormProgress(questions: readonly MoveInFormQuestion[], map: MoveInAnswerMap): MoveInFormProgress {
  const visible = visibleMoveInQuestions(questions, map);
  const answered = visible.filter((q) => isMoveInQuestionAnswered(q, map[q.key])).length;
  const missing = visible.filter((q) => q.required && !isMoveInQuestionAnswered(q, map[q.key]));
  const firstOpen = visible.findIndex((q) => !isMoveInQuestionAnswered(q, map[q.key]));
  return {
    total: visible.length,
    answered,
    ratio: visible.length === 0 ? 0 : answered / visible.length,
    missing,
    resumeIndex: firstOpen === -1 ? Math.max(visible.length - 1, 0) : firstOpen,
  };
}

/** The message a required question shows when left empty. */
export function requiredMessage(question: MoveInFormQuestion): string {
  if (question.type === "checkbox") return "This box must be checked to continue.";
  if (question.type === "signature") return "Sign to continue.";
  if (question.type === "photos" || question.type === "file") return "Add at least one photo.";
  return "This is required.";
}

/* ───────────────────────────── list wording ───────────────────────────── */

export function triggerSummary(trigger: MoveInFormTrigger): string {
  if (trigger === "lease-signed") return "When lease is signed";
  if (trigger === "application-approved") return "When application is approved";
  return "Sent by hand";
}

export const MOVE_IN_TRIGGER_OPTIONS: { value: MoveInFormTrigger; label: string }[] = [
  { value: "lease-signed", label: "When the lease is signed" },
  { value: "application-approved", label: "When the application is approved" },
  { value: "manual", label: "Only when I send it" },
];

export const MOVE_IN_DUE_OPTIONS: { value: MoveInFormDueRule; label: string }[] = [
  { value: "day-before", label: "The day before move-in" },
  { value: "move-in-day", label: "On move-in day" },
  { value: "3-days-before", label: "3 days before move-in" },
  { value: "7-days-before", label: "7 days before move-in" },
];

export function audienceSummary(audience: MoveInFormAudience, rooms: readonly { id: string; label: string }[]): string {
  if (audience.kind === "whole-house") return "Whole house";
  if (audience.kind === "every-room") return "Every room";
  const labels = audience.roomIds.map((id) => rooms.find((room) => room.id === id)?.label).filter((label): label is string => Boolean(label));
  if (labels.length === 0) return "No rooms picked";
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.length} rooms`;
}

export function questionCountLabel(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

export function templateSourceLine(template: Pick<MoveInFormTemplate, "source" | "pdf">): string {
  if (template.source === "built") return "Built in PropLane";
  if (!template.pdf) return "PDF not uploaded yet";
  const pages = template.pdf.pageCount;
  return `${template.pdf.fileName} · ${pages} page${pages === 1 ? "" : "s"}`;
}

/** The row's right-hand figure: "3 of 4 residents", "0 sent", or "Turned off". */
export function templateFigure(template: Pick<MoveInFormTemplate, "id" | "enabled">, forms: readonly Pick<MoveInFormSummary, "formId" | "status">[]): string {
  if (!template.enabled) return "Turned off";
  const sent = forms.filter((form) => form.formId === template.id && form.status !== "cancelled");
  if (sent.length === 0) return "0 sent";
  const done = sent.filter((form) => form.status === "submitted").length;
  return `${done} of ${sent.length} resident${sent.length === 1 ? "" : "s"}`;
}

/** "Oct 1" in the product's Pacific wall clock. */
export function formatDueDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }).format(date);
}

export function isMoveInFormLate(dueAt: string | null | undefined, now = Date.now()): boolean {
  if (!dueAt) return false;
  const due = new Date(dueAt).getTime();
  return Number.isFinite(due) && due < now;
}

/* ───────────────────────────── template list ───────────────────────────── */

function nowIso(): string {
  return new Date().toISOString();
}

export function upsertMoveInTemplate(list: readonly MoveInFormTemplate[], template: MoveInFormTemplate): MoveInFormTemplate[] {
  const next = { ...template, updatedAt: nowIso() };
  const exists = list.some((item) => item.id === template.id);
  return exists ? list.map((item) => (item.id === template.id ? next : item)) : [...list, next];
}

export function removeMoveInTemplate(list: readonly MoveInFormTemplate[], id: string): MoveInFormTemplate[] {
  return list.filter((item) => item.id !== id);
}

export function setMoveInTemplateEnabled(list: readonly MoveInFormTemplate[], id: string, enabled: boolean): MoveInFormTemplate[] {
  return list.map((item) => (item.id === id ? { ...item, enabled, updatedAt: nowIso() } : item));
}

/** A copy sits right after its original, with a new id, turned OFF so nothing new goes out until the manager says so. */
export function duplicateMoveInTemplate(
  list: readonly MoveInFormTemplate[],
  id: string,
  newId: string,
): { list: MoveInFormTemplate[]; copy: MoveInFormTemplate | null } {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return { list: [...list], copy: null };
  const original = list[index]!;
  const stamp = nowIso();
  const copy: MoveInFormTemplate = {
    ...structuredClone(original),
    id: newId,
    name: `${original.name || "Untitled form"} (copy)`,
    enabled: false,
    // An uploaded PDF is stored under its own form id; a copy uploads its own.
    pdf: original.source === "upload" ? null : (original.pdf ?? null),
    starterKey: undefined,
    createdAt: stamp,
    updatedAt: stamp,
  };
  delete copy.starterKey;
  const next = [...list];
  next.splice(index + 1, 0, copy);
  return { list: next, copy };
}

/** A copy for another property: new ids would be needed per target, so the caller passes the id to give it. */
export function copyTemplateToProperty(template: MoveInFormTemplate, newId: string): MoveInFormTemplate {
  const stamp = nowIso();
  const copy: MoveInFormTemplate = {
    ...structuredClone(template),
    id: newId,
    enabled: false,
    // The PDF lives under the source property's storage; a copy asks for its own upload.
    pdf: null,
    // Rooms belong to the source property; a copy asks for rooms again rather than pointing at strangers.
    audience: template.audience.kind === "rooms" ? { kind: "every-room" } : template.audience,
    createdAt: stamp,
    updatedAt: stamp,
  };
  delete copy.starterKey;
  return copy;
}

/* ───────────────────────────── questions / sections ───────────────────────────── */

export const MOVE_IN_QUESTION_TYPE_OPTIONS: { value: MoveInFormQuestion["type"]; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "long_text", label: "Long answer" },
  { value: "yes_no", label: "Yes / no" },
  { value: "select", label: "Pick one" },
  { value: "multi_select", label: "Pick several" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Amount" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "photos", label: "Photo" },
  { value: "initials", label: "Initials" },
  { value: "signature", label: "Signature" },
];

export function moveInQuestionTypeLabel(type: MoveInFormQuestion["type"]): string {
  return MOVE_IN_QUESTION_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? (type === "file" ? "File" : type);
}

export function questionTypeHasOptions(type: MoveInFormQuestion["type"]): boolean {
  return type === "select" || type === "multi_select";
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** A stable answer key, unique inside the form. It is minted once and never follows later label edits. */
export function uniqueQuestionKey(taken: ReadonlySet<string>, seed = ""): string {
  const base = slug(seed) || "question";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

export type MoveInSection = { name: string; questions: MoveInFormQuestion[] };

/** Sections in first-seen order. A question with no section sits in the unnamed section "". */
export function groupQuestionsBySection(questions: readonly MoveInFormQuestion[]): MoveInSection[] {
  const sections: MoveInSection[] = [];
  for (const question of questions) {
    const name = question.section?.trim() ?? "";
    let section = sections.find((item) => item.name === name);
    if (!section) {
      section = { name, questions: [] };
      sections.push(section);
    }
    section.questions.push(question);
  }
  return sections;
}

export function flattenSections(sections: readonly MoveInSection[]): MoveInFormQuestion[] {
  return sections.flatMap((section) =>
    section.questions.map((question) => {
      const next: MoveInFormQuestion = { ...question };
      if (section.name) next.section = section.name;
      else delete next.section;
      return next;
    }),
  );
}

export function newMoveInQuestion(questions: readonly MoveInFormQuestion[], section: string): MoveInFormQuestion {
  const taken = new Set(questions.map((q) => q.key));
  const key = uniqueQuestionKey(taken, `q ${questions.length + 1}`);
  const question: MoveInFormQuestion = { id: `q-${key}`, key, label: "", type: "text", required: false, options: [] };
  if (section) question.section = section;
  return question;
}

/** Adds a blank question at the end of `section` (or the end of the form when that section does not exist yet). */
export function addMoveInQuestion(questions: readonly MoveInFormQuestion[], section: string): MoveInFormQuestion[] {
  const sections = groupQuestionsBySection(questions);
  const target = sections.find((item) => item.name === section) ?? sections[sections.length - 1];
  const created = newMoveInQuestion(questions, target ? target.name : section);
  if (!target) return [created];
  target.questions.push(created);
  return flattenSections(sections);
}

/** A new section starts with one blank question, so it exists in the stored list. */
export function addMoveInSection(questions: readonly MoveInFormQuestion[]): MoveInFormQuestion[] {
  const names = new Set(groupQuestionsBySection(questions).map((section) => section.name));
  let n = names.size + 1;
  while (names.has(`Section ${n}`)) n += 1;
  return [...questions, newMoveInQuestion(questions, `Section ${n}`)];
}

export function renameMoveInSection(questions: readonly MoveInFormQuestion[], from: string, to: string): MoveInFormQuestion[] {
  const name = to.trim();
  return questions.map((question) => {
    if ((question.section?.trim() ?? "") !== from) return question;
    const next = { ...question };
    if (name) next.section = name;
    else delete next.section;
    return next;
  });
}

export function removeMoveInSection(questions: readonly MoveInFormQuestion[], name: string): MoveInFormQuestion[] {
  return questions.filter((question) => (question.section?.trim() ?? "") !== name);
}

export function removeMoveInQuestion(questions: readonly MoveInFormQuestion[], id: string): MoveInFormQuestion[] {
  return questions.filter((question) => question.id !== id);
}

/** Changing the type drops what the new type cannot use; a signature is always required. */
export function updateMoveInQuestion(
  questions: readonly MoveInFormQuestion[],
  id: string,
  patch: Partial<Pick<MoveInFormQuestion, "label" | "type" | "required" | "options" | "description">>,
): MoveInFormQuestion[] {
  return questions.map((question) => {
    if (question.id !== id) return question;
    const next: MoveInFormQuestion = { ...question, ...patch };
    if (patch.type) {
      if (!questionTypeHasOptions(patch.type)) next.options = [];
      else if (!next.options.length) next.options = ["Option 1", "Option 2"];
    }
    if (next.type === "signature") next.required = true;
    return next;
  });
}

/** `orderedIds` is the new order of one section's questions; every other section keeps its place. */
export function reorderMoveInSection(questions: readonly MoveInFormQuestion[], section: string, orderedIds: readonly string[]): MoveInFormQuestion[] {
  const sections = groupQuestionsBySection(questions);
  const target = sections.find((item) => item.name === section);
  if (!target) return [...questions];
  const byId = new Map(target.questions.map((q) => [q.id, q] as const));
  const reordered = orderedIds.map((id) => byId.get(id)).filter((q): q is MoveInFormQuestion => Boolean(q));
  if (reordered.length !== target.questions.length) return [...questions];
  target.questions = reordered;
  return flattenSections(sections);
}

export type MoveInFormStepProblems = { form: string[]; questions: string[]; who: string[] };

/** What stops a form from being saved, by the builder step that owns the fix. All empty = saveable. */
export function moveInFormProblemsByStep(
  template: Pick<MoveInFormTemplate, "name" | "source" | "pdf" | "questions" | "audience">,
): MoveInFormStepProblems {
  const form: string[] = [];
  const questions: string[] = [];
  const who: string[] = [];
  if (!template.name.trim()) form.push("Name this form.");
  if (template.source === "upload" && !template.pdf) form.push("Upload the PDF.");
  if (template.source === "built" && template.questions.length === 0) questions.push("Add at least one question.");
  if (template.questions.some((q) => !q.label.trim())) questions.push("Every question needs words.");
  if (template.questions.some((q) => questionTypeHasOptions(q.type) && q.options.filter((o) => o.trim()).length < 2)) {
    questions.push("A pick question needs at least two choices.");
  }
  if (template.source === "upload" && !template.questions.some((q) => q.type === "signature")) questions.push("Add the signature.");
  if (template.audience.kind === "rooms" && template.audience.roomIds.length === 0) who.push("Pick at least one room.");
  return { form, questions, who };
}

export function moveInFormProblems(template: Parameters<typeof moveInFormProblemsByStep>[0]): string[] {
  const byStep = moveInFormProblemsByStep(template);
  return [...byStep.form, ...byStep.questions, ...byStep.who];
}

/** Blank questions are dropped and option lists trimmed before a form is written to the property. */
export function cleanMoveInTemplateForSave(template: MoveInFormTemplate): MoveInFormTemplate {
  return {
    ...template,
    name: template.name.trim(),
    questions: template.questions
      .filter((q) => q.label.trim())
      .map((q) => ({
        ...q,
        label: q.label.trim(),
        options: questionTypeHasOptions(q.type) ? q.options.map((o) => o.trim()).filter(Boolean) : [],
      })),
  };
}

/* ───────────────────────────── new-tab preview ───────────────────────────── */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

/** A printable page of a built form's questions — what "Open in new tab" shows for a form that has no PDF. */
export function moveInFormPreviewHtml(template: Pick<MoveInFormTemplate, "name" | "questions">): string {
  const sections = groupQuestionsBySection(template.questions);
  const body = sections
    .map((section) => {
      const heading = section.name ? `<h2>${escapeHtml(section.name)}</h2>` : "";
      const items = section.questions
        .map((q) => {
          const choices = q.options.length ? `<div class="o">${q.options.map(escapeHtml).join(" · ")}</div>` : "";
          return `<li><b>${escapeHtml(q.label || "Question")}</b>${q.required ? " *" : ""}<span class="t">${escapeHtml(moveInQuestionTypeLabel(q.type))}</span>${choices}</li>`;
        })
        .join("");
      return `${heading}<ol>${items}</ol>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(template.name || "Move-in form")}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#111}h1{font-size:22px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-top:28px}ol{padding-left:20px}li{margin:10px 0}.t{margin-left:8px;color:#777;font-size:12px}.o{color:#555;font-size:13px}</style></head><body><h1>${escapeHtml(template.name || "Move-in form")}</h1>${body}</body></html>`;
}
