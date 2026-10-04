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
import { isDefaultMoveInForm } from "@/lib/move-in-forms/templates";
import type {
  MoveInFormAnswer,
  MoveInFormAudience,
  MoveInFormDueRule,
  MoveInFormKind,
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

export function triggerSummary(trigger: MoveInFormTrigger, moveOutDaysBefore = 14): string {
  if (trigger === "application-submitted") return "After application is submitted";
  if (trigger === "application-approved") return "After application is approved";
  if (trigger === "lease-signed") return "After lease is signed";
  if (trigger === "before-move-out") return `${moveOutDaysBefore} days before move-out`;
  return "Sent by hand";
}

export const MOVE_IN_TRIGGER_OPTIONS: { value: MoveInFormTrigger; label: string }[] = [
  { value: "application-submitted", label: "After the application is submitted" },
  { value: "application-approved", label: "After the application is approved" },
  { value: "lease-signed", label: "After the lease is signed" },
  { value: "before-move-out", label: "Before move-out" },
  { value: "manual", label: "Only when I send it" },
];

export const MOVE_OUT_DAYS_CHOICES: { value: string; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];

export const MOVE_IN_DUE_OPTIONS: { value: MoveInFormDueRule; label: string }[] = [
  { value: "day-before", label: "The day before move-in" },
  { value: "move-in-day", label: "On move-in day" },
  { value: "3-days-before", label: "3 days before move-in" },
  { value: "7-days-before", label: "7 days before move-in" },
  { value: "3-days-after-sent", label: "3 days after it is sent" },
  { value: "7-days-after-sent", label: "7 days after it is sent" },
  { value: "move-out-day", label: "On move-out day" },
  { value: "3-days-before-move-out", label: "3 days before move-out" },
  { value: "7-days-before-move-out", label: "7 days before move-out" },
];

const MOVE_IN_DUE_RULES: MoveInFormDueRule[] = ["day-before", "move-in-day", "3-days-before", "7-days-before"];
const SENT_DUE_RULES: MoveInFormDueRule[] = ["3-days-after-sent", "7-days-after-sent"];
const MOVE_OUT_DUE_RULES: MoveInFormDueRule[] = ["move-out-day", "3-days-before-move-out", "7-days-before-move-out"];

/** The Due choices that make sense for a Sends choice: move-out dates only for a move-out send, and so on. */
export function dueOptionsForTrigger(trigger: MoveInFormTrigger): { value: MoveInFormDueRule; label: string }[] {
  const allowed: MoveInFormDueRule[] = trigger === "before-move-out"
    ? [...MOVE_OUT_DUE_RULES, ...SENT_DUE_RULES]
    : trigger === "application-submitted"
      ? [...SENT_DUE_RULES, ...MOVE_IN_DUE_RULES]
      : [...MOVE_IN_DUE_RULES, ...SENT_DUE_RULES];
  return MOVE_IN_DUE_OPTIONS.filter((option) => allowed.includes(option.value));
}

/** Changing Sends keeps the Due the manager chose when it still makes sense, else picks the natural one. */
export function dueForTriggerChange(trigger: MoveInFormTrigger, current: MoveInFormDueRule): MoveInFormDueRule {
  const options = dueOptionsForTrigger(trigger);
  if (options.some((option) => option.value === current)) return current;
  return options[0]!.value;
}

export const MOVE_IN_KIND_OPTIONS: { value: MoveInFormKind; label: string }[] = [
  { value: "intake", label: "Intake" },
  { value: "move-in", label: "Move-in" },
  { value: "move-out", label: "Move-out" },
  { value: "other", label: "Other" },
];

export function moveInKindLabel(kind: MoveInFormKind): string {
  return MOVE_IN_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? "Other";
}

/** "All applications" / "Standard application" / "2 applications": the linked templates, in plain words. */
export function linkedTemplatesSummary(
  linkedIds: readonly string[],
  options: readonly { id: string; label: string }[],
  noun: "application" | "lease",
): string {
  if (linkedIds.length === 0) return `All ${noun}s`;
  const names = linkedIds.map((id) => options.find((option) => option.id === id)?.label).filter((name): name is string => Boolean(name));
  if (names.length === 1) return names[0]!;
  return `${linkedIds.length} ${noun}${linkedIds.length === 1 ? "" : "s"}`;
}

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

export type MoveInFormRowFactId = "questions" | "audience" | "sends" | "source" | "linked";

/**
 * The facts on a property move-in form row, in reading order: how many questions, who gets it (only when it
 * is not every room), when it sends, "PDF" for an uploaded PDF (a form built in PropLane says nothing), and
 * which application / lease it is tied to (only the part that is not the default of "all"). One glyph line.
 */
export function moveInFormRowFacts(
  template: Pick<MoveInFormTemplate, "source" | "questions" | "audience" | "trigger" | "moveOutDaysBefore" | "linkedApplicationTemplateIds" | "linkedLeaseTemplateIds">,
  rooms: readonly { id: string; label: string }[],
  applicationTemplates: readonly { id: string; label: string }[],
  leaseTemplates: readonly { id: string; label: string }[],
): { id: MoveInFormRowFactId; text: string }[] {
  const facts: { id: MoveInFormRowFactId; text: string }[] = [
    { id: "questions", text: questionCountLabel(template.questions.length) },
  ];
  if (template.audience.kind !== "every-room") facts.push({ id: "audience", text: audienceSummary(template.audience, rooms) });
  facts.push({ id: "sends", text: triggerSummary(template.trigger, template.moveOutDaysBefore) });
  if (template.source === "upload") facts.push({ id: "source", text: "PDF" });
  const linked: string[] = [];
  if (template.linkedApplicationTemplateIds.length > 0) {
    linked.push(linkedTemplatesSummary(template.linkedApplicationTemplateIds, applicationTemplates, "application"));
  }
  if (template.linkedLeaseTemplateIds.length > 0) {
    linked.push(linkedTemplatesSummary(template.linkedLeaseTemplateIds, leaseTemplates, "lease"));
  }
  if (linked.length > 0) facts.push({ id: "linked", text: linked.join(" · ") });
  return facts;
}

/** The row's right-hand figure: "3 of 4 residents" once the form has been sent, otherwise nothing at all. */
export function templateFigure(template: Pick<MoveInFormTemplate, "id">, forms: readonly Pick<MoveInFormSummary, "formId" | "status">[]): string {
  const sent = forms.filter((form) => form.formId === template.id && form.status !== "cancelled");
  if (sent.length === 0) return "";
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

/** The three default forms are never deleted (the server re-adds them); everything else can be. */
export function removeMoveInTemplate(list: readonly MoveInFormTemplate[], id: string): MoveInFormTemplate[] {
  return list.filter((item) => item.id !== id || isDefaultMoveInForm(item));
}

/** A copy sits right after its original, with a new id, set to "only when I send it" so a duplicate never double-sends on its own. */
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
    trigger: "manual",
    // Only the three default forms carry a kind; a copy is an ordinary form.
    kind: "other",
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
    trigger: "manual",
    kind: "other",
    // Templates belong to the source property; a copy links to this property's own.
    linkedApplicationTemplateIds: [],
    linkedLeaseTemplateIds: [],
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
  patch: Partial<Pick<MoveInFormQuestion, "label" | "type" | "required" | "options" | "description" | "showIf">>,
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

/** Moves a question one place up or down inside its own section; a no-op at either end. */
export function moveMoveInQuestion(questions: readonly MoveInFormQuestion[], id: string, direction: "up" | "down"): MoveInFormQuestion[] {
  const sections = groupQuestionsBySection(questions);
  const section = sections.find((item) => item.questions.some((q) => q.id === id));
  if (!section) return [...questions];
  const at = section.questions.findIndex((q) => q.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= section.questions.length) return [...questions];
  const moved = section.questions[at]!;
  section.questions[at] = section.questions[to]!;
  section.questions[to] = moved;
  return flattenSections(sections);
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
