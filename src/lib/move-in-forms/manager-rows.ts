/**
 * Pure helpers behind the manager's Move-in forms list and the resident record's Move-in tab:
 * which tab a form belongs to, the glyph facts a row shows, how late a form is, and the list
 * filters. No React, no I/O, so the row copy is unit-tested without rendering anything.
 */
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormSummary } from "./types";

/** Whether a copy is still owed (`waiting`) or filed (`submitted`). A cancelled copy is neither. */
export type MoveInFormStatusBucket = "submitted" | "waiting";

/** A cancelled request is in neither bucket: the manager withdrew it, so nothing is owed or filed. */
export function moveInFormTab(form: Pick<MoveInFormSummary, "status">): MoveInFormStatusBucket | null {
  if (form.status === "submitted") return "submitted";
  if (form.status === "sent") return "waiting";
  return null;
}

/** A form name compared the way tabs group it: trimmed, inner spaces collapsed, case-insensitive. */
export function moveInFormNameKey(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** One tab of the manager's Move-in page: every form with this (normalized) name, across properties. */
export type MoveInFormTabGroup = {
  /** The tab id and URL segment: a slug of the name. */
  id: string;
  /** Normalized name; copies and stored forms match on it. */
  key: string;
  /** How the name reads on the tab (the first spelling in code order, so a capitalised one wins). */
  label: string;
};

/** Slugs the router itself owns under `/move-in/`; a form with such a name gets a `-form` suffix. */
const RESERVED_TAB_SLUGS: readonly string[] = ["inspections", "waiting", "submitted"];

function slugOf(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "form";
}

/**
 * The page's tabs: one per distinct form name among `storedNames` (the forms the manager has added to
 * their properties) and the names of the loaded copies, so a renamed or deleted form's copies still
 * show under the name they were sent with. A cancelled copy alone never makes a tab. Alphabetical by
 * name; the id is a slug of it, suffixed when two names would collide.
 */
export function moveInFormTabGroups(storedNames: readonly string[], forms: readonly MoveInFormSummary[]): MoveInFormTabGroup[] {
  const spellings = new Map<string, string[]>();
  const add = (name: string | null | undefined) => {
    const key = moveInFormNameKey(name);
    if (!key) return;
    const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
    const list = spellings.get(key);
    if (list) list.push(trimmed);
    else spellings.set(key, [trimmed]);
  };
  for (const name of storedNames) add(name);
  for (const form of forms) if (moveInFormTab(form)) add(form.formName);
  const sorted = [...spellings].map(([key, names]) => ({
    key,
    label: [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]!,
  }));
  sorted.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
  const taken = new Set<string>();
  return sorted.map(({ key, label }) => {
    let base = slugOf(label);
    if (RESERVED_TAB_SLUGS.includes(base)) base = `${base}-form`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return { id, key, label };
  });
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

export type MoveInFormFilters = {
  propertyId?: string;
  /** Narrow to copies still owed or already filed. */
  status?: MoveInFormStatusBucket;
  /** Only copies of this form (matched like a tab: trimmed, case-insensitive). */
  formName?: string;
  query?: string;
};

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

/**
 * Every word typed must appear somewhere in the row's resident, form, property, room or facts.
 * Cancelled copies never list. The result is in tab order (`sortMoveInFormsForTab`).
 */
export function filterMoveInForms(forms: MoveInFormSummary[], filters: MoveInFormFilters, now: Date = new Date()): MoveInFormSummary[] {
  const words = (filters.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = forms.filter((form) => {
    const bucket = moveInFormTab(form);
    if (!bucket) return false;
    if (filters.status && bucket !== filters.status) return false;
    if (filters.propertyId && form.propertyId !== filters.propertyId) return false;
    if (filters.formName && moveInFormNameKey(form.formName) !== moveInFormNameKey(filters.formName)) return false;
    if (words.length === 0) return true;
    const haystack = [form.residentName, form.formName, form.propertyLabel, form.roomLabel, ...moveInFormFacts(form, now).map((fact) => fact.text)]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return sortMoveInFormsForTab(matched, now);
}

/** Rows per tab, keyed by tab id (sent and submitted together, cancelled excluded). A form with no copies counts 0. */
export function moveInFormTabCounts(groups: readonly MoveInFormTabGroup[], forms: readonly MoveInFormSummary[]): Record<string, number> {
  const byKey = new Map(groups.map((group) => [group.key, group.id]));
  const counts: Record<string, number> = Object.fromEntries(groups.map((group) => [group.id, 0]));
  for (const form of forms) {
    if (!moveInFormTab(form)) continue;
    const id = byKey.get(moveInFormNameKey(form.formName));
    if (id) counts[id] = (counts[id] ?? 0) + 1;
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
