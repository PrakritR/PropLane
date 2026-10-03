/**
 * Pure helpers behind the manager's Move-in forms list and the resident record's Move-in tab:
 * which tab a form belongs to, the glyph facts a row shows, how late a form is, and the list
 * filters. No React, no I/O, so the row copy is unit-tested without rendering anything.
 */
import type { MoveInFormAnswer, MoveInFormKind, MoveInFormQuestion, MoveInFormSummary } from "./types";

export type MoveInFormListTab = "submitted" | "waiting";

/** A cancelled request is on neither tab: the manager withdrew it, so nothing is owed or filed. */
export function moveInFormTab(form: Pick<MoveInFormSummary, "status">): MoveInFormListTab | null {
  if (form.status === "submitted") return "submitted";
  if (form.status === "sent") return "waiting";
  return null;
}

const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` of an instant on the product's wall clock (Pacific). Empty for an unusable value. */
export function pacificDay(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return PACIFIC_DAY.format(date);
}

/** "Sep 27" for an instant, on the Pacific wall clock. Empty when the value is missing or invalid. */
export function formatMoveInDate(value: string | null | undefined): string {
  const day = pacificDay(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}` : "";
}

/**
 * Whole days a waiting form is past its due DAY (Pacific): due Oct 1, today Oct 3 is 2. Zero when it
 * is not late, has no due date, or is no longer waiting.
 */
export function moveInFormDaysLate(form: Pick<MoveInFormSummary, "status" | "dueAt">, now: Date = new Date()): number {
  if (form.status !== "sent" || !form.dueAt) return 0;
  const due = pacificDay(form.dueAt);
  const today = pacificDay(now);
  if (!due || !today || today <= due) return 0;
  const toUtc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(today) - toUtc(due)) / 86_400_000);
}

export function lateLabel(daysLate: number): string {
  return `${daysLate} ${daysLate === 1 ? "day" : "days"} late`;
}

export type MoveInFormFact = {
  id: "submitted" | "signed" | "photos" | "sent" | "due";
  text: string;
  /** Plain red text, never a chip. */
  late?: boolean;
};

/**
 * The glyph facts under a row's place line.
 * Submitted: `Submitted Sep 27` · `Signed` · `4 photos`.
 * Waiting:   `Sent Sep 28` · `Due Oct 1`, or `Due Oct 1 · 2 days late` once past due.
 */
export function moveInFormFacts(form: MoveInFormSummary, now: Date = new Date()): MoveInFormFact[] {
  if (form.status === "submitted") {
    const facts: MoveInFormFact[] = [];
    const date = formatMoveInDate(form.submittedAt);
    facts.push({ id: "submitted", text: date ? `Submitted ${date}` : "Submitted" });
    if (form.signed) facts.push({ id: "signed", text: "Signed" });
    if (form.photoCount > 0) facts.push({ id: "photos", text: `${form.photoCount} ${form.photoCount === 1 ? "photo" : "photos"}` });
    return facts;
  }
  const facts: MoveInFormFact[] = [];
  const sent = formatMoveInDate(form.sentAt);
  facts.push({ id: "sent", text: sent ? `Sent ${sent}` : "Sent" });
  const due = formatMoveInDate(form.dueAt);
  if (due) {
    const late = moveInFormDaysLate(form, now);
    facts.push(late > 0 ? { id: "due", text: `Due ${due} · ${lateLabel(late)}`, late: true } : { id: "due", text: `Due ${due}` });
  }
  return facts;
}

/** The row title: who and which form. */
export function moveInFormTitle(form: Pick<MoveInFormSummary, "residentName" | "formName">): string {
  const who = form.residentName.trim() || "Resident";
  return `${who} · ${form.formName}`;
}

/** The place line: property then room, skipping a blank half. */
export function moveInFormPlaceLine(form: Pick<MoveInFormSummary, "propertyLabel" | "roomLabel">): string {
  return [form.propertyLabel, form.roomLabel].map((part) => part.trim()).filter(Boolean).join(" · ");
}

/** The Form filter on Waiting and Submitted, in the order the filter offers it. */
export const MOVE_IN_FORM_KIND_OPTIONS: ReadonlyArray<{ value: MoveInFormKind; label: string }> = [
  { value: "intake", label: "Intake" },
  { value: "move-in", label: "Move-in" },
  { value: "move-out", label: "Move-out" },
  { value: "other", label: "Other" },
];

/** "Move-in" for `move-in`; an unknown or missing kind reads as "Other". */
export function moveInFormKindLabel(kind: MoveInFormKind | string | null | undefined): string {
  return MOVE_IN_FORM_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? "Other";
}

export type MoveInFormFilters = {
  tab?: MoveInFormListTab;
  propertyId?: string;
  /** Narrow to one kind of form (Intake, Move-in, Move-out, Other). A copy with no kind counts as Other. */
  kind?: MoveInFormKind;
  formName?: string;
  query?: string;
};

/** Every word typed must appear somewhere in the row's resident, form, property, room or facts. */
export function filterMoveInForms(forms: MoveInFormSummary[], filters: MoveInFormFilters, now: Date = new Date()): MoveInFormSummary[] {
  const words = (filters.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return forms.filter((form) => {
    const tab = moveInFormTab(form);
    if (!tab) return false;
    if (filters.tab && tab !== filters.tab) return false;
    if (filters.propertyId && form.propertyId !== filters.propertyId) return false;
    if (filters.kind && (form.kind ?? "other") !== filters.kind) return false;
    if (filters.formName && form.formName.trim().toLowerCase() !== filters.formName.trim().toLowerCase()) return false;
    if (words.length === 0) return true;
    const haystack = [form.residentName, form.formName, form.propertyLabel, form.roomLabel, ...moveInFormFacts(form, now).map((fact) => fact.text)]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function moveInFormTabCounts(forms: MoveInFormSummary[]): Record<MoveInFormListTab, number> {
  const counts: Record<MoveInFormListTab, number> = { submitted: 0, waiting: 0 };
  for (const form of forms) {
    const tab = moveInFormTab(form);
    if (tab) counts[tab] += 1;
  }
  return counts;
}

/** Waiting forms that are past due, most overdue first. Feeds the resident Overview's "Needs you". */
export function lateMoveInForms(forms: MoveInFormSummary[], now: Date = new Date()): Array<{ form: MoveInFormSummary; daysLate: number }> {
  return forms
    .map((form) => ({ form, daysLate: moveInFormDaysLate(form, now) }))
    .filter((entry) => entry.daysLate > 0)
    .sort((a, b) => b.daysLate - a.daysLate || a.form.formName.localeCompare(b.form.formName));
}

/** "<Form> is 2 days late" — the Overview line. */
export function lateFormNeedsLine(formName: string, daysLate: number): string {
  return `${formName} is ${lateLabel(daysLate)}`;
}

/* ---------------------------------------------------------------- answers (viewer) */

export type MoveInAnswerView =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "files"; paths: string[] }
  | { kind: "signature"; storagePath: string; signedName: string; signedAt: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-03` (a wall date a resident picked) as "Oct 3, 2026". Anything else is returned as typed. */
export function formatWallDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return raw;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : raw;
}

/** "Sep 27, 4:12 PM" for an instant, on the Pacific wall clock. */
export function formatMoveInStamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = formatMoveInDate(value);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(date);
  return `${day}, ${time}`;
}

function scalarText(value: unknown, type: MoveInFormQuestion["type"]): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join(", ");
  const text = String(value).trim();
  if (!text) return "";
  if (type === "yes_no") {
    const lower = text.toLowerCase();
    if (lower === "yes" || lower === "true") return "Yes";
    if (lower === "no" || lower === "false") return "No";
  }
  if (type === "date") return formatWallDate(text);
  return text;
}

/** How one answer reads in the viewer. Photos and the signature stay paths: the caller mints the URLs. */
export function moveInAnswerView(question: Pick<MoveInFormQuestion, "type">, answer: MoveInFormAnswer | undefined): MoveInAnswerView {
  if (!answer) return { kind: "empty" };
  if ("signature" in answer) {
    return { kind: "signature", storagePath: answer.signature.storagePath, signedName: answer.signature.signedName, signedAt: answer.signature.signedAt };
  }
  if ("files" in answer) return answer.files.length ? { kind: "files", paths: answer.files } : { kind: "empty" };
  const text = scalarText(answer.value, question.type);
  return text ? { kind: "text", text } : { kind: "empty" };
}

export type MoveInAnswerGroup = {
  title: string;
  rows: Array<{ question: MoveInFormQuestion; view: MoveInAnswerView }>;
};

function answerComparable(answer: MoveInFormAnswer | undefined): string {
  if (!answer || !("value" in answer)) return "";
  const value = answer.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The submission as the resident answered it, grouped by the snapshot's own sections. A question
 * that only appears under a condition ("Make" after "Will you park a vehicle?") is listed only when
 * its condition held or it was answered anyway; everything else shows even when left blank.
 */
export function groupMoveInAnswers(questions: MoveInFormQuestion[], answers: MoveInFormAnswer[]): MoveInAnswerGroup[] {
  const byKey = new Map(answers.map((answer) => [answer.key, answer]));
  const groups: MoveInAnswerGroup[] = [];
  for (const question of questions) {
    const answer = byKey.get(question.key);
    const view = moveInAnswerView(question, answer);
    if (question.showIf) {
      const held = answerComparable(byKey.get(question.showIf.fieldKey)) === question.showIf.equals.trim().toLowerCase();
      if (!held && view.kind === "empty") continue;
    }
    const title = question.section?.trim() || "Answers";
    let group = groups.find((entry) => entry.title === title);
    if (!group) {
      group = { title, rows: [] };
      groups.push(group);
    }
    group.rows.push({ question, view });
  }
  return groups;
}
