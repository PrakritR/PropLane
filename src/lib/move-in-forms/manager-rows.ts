/**
 * Pure helpers behind the manager's Forms list and the resident record's Forms tab: the glyph facts a
 * row shows, how late a form is, and the list's one filter/count pair (`filterFormsList` /
 * `formsBucketCounts`). No React, no I/O, so the row copy is unit-tested without rendering anything.
 */
import {
  MOVE_IN_FORM_BLOCKS_LABELS,
  resolveMoveInFormBlocks,
  type MoveInFormAnswer,
  type MoveInFormBlocks,
  type MoveInFormKind,
  type MoveInFormQuestion,
  type MoveInFormSummary,
} from "./types";

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

/** The row title: who and which form. */
export function moveInFormTitle(form: Pick<MoveInFormSummary, "residentName" | "formName">): string {
  const who = form.residentName.trim() || "Resident";
  return `${who} · ${form.formName}`;
}

/** The place line: property then room, skipping a blank half. */
export function moveInFormPlaceLine(form: Pick<MoveInFormSummary, "propertyLabel" | "roomLabel">): string {
  return [form.propertyLabel, form.roomLabel].map((part) => part.trim()).filter(Boolean).join(" · ");
}

/**
 * One tab's order: late first (most days late first), then the rest of the waiting copies by due
 * date (no due date last), then submitted newest first.
 */
export function sortMoveInFormsForTab(forms: MoveInFormSummary[], now: Date = new Date()): MoveInFormSummary[] {
  const time = (value: string | null | undefined, fallback: number) => {
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(t) ? fallback : t;
  };
  const rank = (form: MoveInFormSummary) => (moveInFormDaysLate(form, now) > 0 ? 0 : form.status === "sent" ? 1 : 2);
  return [...forms].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (rank(a) === 0) return moveInFormDaysLate(b, now) - moveInFormDaysLate(a, now) || time(a.dueAt, Infinity) - time(b.dueAt, Infinity);
    if (rank(a) === 1) return time(a.dueAt, Infinity) - time(b.dueAt, Infinity) || time(b.sentAt, 0) - time(a.sentAt, 0);
    return time(b.submittedAt, 0) - time(a.submittedAt, 0);
  });
}

/* ------------------------------------------------------------ the Forms list (sidebar + resident record) */

/** The Forms list's two tabs: Pending is a `sent` copy, Completed a `submitted` one. A cancelled copy is in neither. */
export type FormsListBucket = "pending" | "completed";

export function formsBucketOf(form: Pick<MoveInFormSummary, "status">): FormsListBucket | null {
  if (form.status === "sent") return "pending";
  if (form.status === "submitted") return "completed";
  return null;
}

export function formsBucketCounts(forms: readonly Pick<MoveInFormSummary, "status">[]): Record<FormsListBucket, number> {
  const counts: Record<FormsListBucket, number> = { pending: 0, completed: 0 };
  for (const form of forms) {
    const bucket = formsBucketOf(form);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

export const MOVE_IN_FORM_KIND_LABELS: Record<MoveInFormKind, string> = {
  intake: "Intake",
  "move-in": "Move-in",
  "move-out": "Move-out",
  other: "Other",
};

/** What a copy holds back, as the row's plain fact: "Blocks Lease signing" / "Blocks nothing". */
export function formsBlocksFact(form: Pick<MoveInFormSummary, "blocks" | "kind">): string {
  const blocks = resolveMoveInFormBlocks(form.blocks, form.kind);
  return blocks === "nothing" ? "Blocks nothing" : `Blocks ${MOVE_IN_FORM_BLOCKS_LABELS[blocks]}`;
}

/** The row's date fact: "Due Oct 12" (red text once late) for a pending form, "Submitted Oct 2" for a completed one. */
export function formsDateFact(form: MoveInFormSummary, now: Date = new Date()): { text: string; late: boolean } {
  if (form.status === "submitted") {
    const date = formatMoveInDate(form.submittedAt);
    return { text: date ? `Submitted ${date}` : "Submitted", late: false };
  }
  const due = formatMoveInDate(form.dueAt);
  if (!due) {
    const sent = formatMoveInDate(form.sentAt);
    return { text: sent ? `Sent ${sent}` : "Sent", late: false };
  }
  const late = moveInFormDaysLate(form, now);
  return late > 0 ? { text: `Due ${due} · ${lateLabel(late)}`, late: true } : { text: `Due ${due}`, late: false };
}

export type FormsListFilters = {
  bucket: FormsListBucket;
  query?: string;
  kinds?: readonly MoveInFormKind[];
  propertyIds?: readonly string[];
  /** Resident application ids. */
  residentIds?: readonly string[];
  blocks?: readonly MoveInFormBlocks[];
};

/** The Forms list rows for one tab, in tab order (late first, then by due date, then newest submitted). */
export function filterFormsList(forms: readonly MoveInFormSummary[], filters: FormsListFilters, now: Date = new Date()): MoveInFormSummary[] {
  const words = (filters.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = forms.filter((form) => {
    if (formsBucketOf(form) !== filters.bucket) return false;
    if (filters.kinds?.length && !filters.kinds.includes(form.kind)) return false;
    if (filters.propertyIds?.length && !filters.propertyIds.includes(form.propertyId)) return false;
    if (filters.residentIds?.length && !filters.residentIds.includes(form.applicationId)) return false;
    if (filters.blocks?.length && !filters.blocks.includes(resolveMoveInFormBlocks(form.blocks, form.kind))) return false;
    if (words.length === 0) return true;
    const haystack = [form.residentName, form.formName, form.propertyLabel, form.roomLabel, formsBlocksFact(form), formsDateFact(form, now).text]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return sortMoveInFormsForTab(matched, now);
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
