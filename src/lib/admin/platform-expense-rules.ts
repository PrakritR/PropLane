/**
 * Client-safe rules for PropLane's own expenses and profit: the category list, how a recurring expense
 * expands into the months it covers, and the profit-and-loss arithmetic. The server modules, the API
 * routes and the Finances panel all import this one file, so the page and the data cannot disagree.
 */

export const EXPENSE_CATEGORIES = [
  { id: "hosting", label: "Hosting" },
  { id: "database", label: "Database" },
  { id: "messaging", label: "Messaging (Twilio)" },
  { id: "ai_models", label: "AI models" },
  { id: "email", label: "Email" },
  { id: "domains", label: "Domains" },
  { id: "app_store", label: "App Store" },
  { id: "software", label: "Software" },
  { id: "marketing", label: "Marketing" },
  { id: "contractors", label: "Contractors" },
  { id: "legal_accounting", label: "Legal & accounting" },
  { id: "other", label: "Other" },
] as const;

export type ExpenseCategoryId = (typeof EXPENSE_CATEGORIES)[number]["id"];

export const EXPENSE_CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.id) as [ExpenseCategoryId, ...ExpenseCategoryId[]];

export function expenseCategoryLabel(id: string): string {
  return EXPENSE_CATEGORIES.find((c) => c.id === id)?.label ?? "Other";
}

export const EXPENSE_RECURRENCES = ["none", "monthly", "yearly"] as const;
export type ExpenseRecurrence = (typeof EXPENSE_RECURRENCES)[number];

export const EXPENSE_RECURRENCE_LABELS: Record<ExpenseRecurrence, string> = {
  none: "One-time",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** One row of `platform_expenses`, as the admin routes and panel see it. */
export type PlatformExpense = {
  id: string;
  category: string;
  vendor: string;
  amountCents: number;
  currency: string;
  /** YYYY-MM-DD. For a recurring expense, the first occurrence. */
  spentOn: string;
  recurrence: ExpenseRecurrence;
  /** YYYY-MM-DD, inclusive: no occurrence after this date. */
  endsOn: string | null;
  receiptPath: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
};

/** One dated charge of an expense. A one-time expense has exactly one. */
export type ExpenseOccurrence = {
  expenseId: string;
  expense: PlatformExpense;
  /** YYYY-MM-DD. */
  date: string;
  month: string;
  amountCents: number;
};

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = MONTH_RE.exec(value);
  return Boolean(m) && Number(m![2]) >= 1 && Number(m![2]) <= 12;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** `count` months ending at (and including) `endMonth`, oldest first. */
export function monthsEndingAt(endMonth: string, count: number): string[] {
  const m = MONTH_RE.exec(endMonth);
  if (!m) return [];
  let y = Number(m[1]);
  let mo = Number(m[2]);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.unshift(`${y}-${pad2(mo)}`);
    mo -= 1;
    if (mo === 0) {
      mo = 12;
      y -= 1;
    }
  }
  return out;
}

export function shiftMonth(month: string, delta: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndex(month: string): number {
  const m = MONTH_RE.exec(month);
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : Number.NaN;
}

/**
 * The date an expense is charged in `month`, or null when it is not charged then.
 *
 * Monthly expenses repeat on the first charge's day of the month (clamped: the 31st lands on the 28th
 * in February); yearly ones repeat in the first charge's month. Nothing is charged before the first
 * date or after `endsOn`.
 */
export function expenseDateInMonth(expense: PlatformExpense, month: string): string | null {
  const first = DATE_RE.exec(expense.spentOn);
  const target = MONTH_RE.exec(month);
  if (!first || !target) return null;
  const firstMonthIdx = monthIndex(monthKeyOf(expense.spentOn));
  const targetIdx = monthIndex(month);
  if (targetIdx < firstMonthIdx) return null;

  let date: string | null = null;
  if (expense.recurrence === "none") {
    date = targetIdx === firstMonthIdx ? expense.spentOn : null;
  } else if (expense.recurrence === "monthly") {
    date = `${month}-${pad2(Math.min(Number(first[3]), daysInMonth(Number(target[1]), Number(target[2]))))}`;
  } else if (Number(target[2]) === Number(first[2])) {
    date = `${month}-${pad2(Math.min(Number(first[3]), daysInMonth(Number(target[1]), Number(target[2]))))}`;
  }
  if (!date) return null;
  if (expense.endsOn && date > expense.endsOn) return null;
  return date;
}

/** Every charge that falls in `month`, newest first. */
export function expandExpensesForMonth(expenses: readonly PlatformExpense[], month: string): ExpenseOccurrence[] {
  const out: ExpenseOccurrence[] = [];
  for (const expense of expenses) {
    const date = expenseDateInMonth(expense, month);
    if (date) out.push({ expenseId: expense.id, expense, date, month, amountCents: expense.amountCents });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.expense.vendor.localeCompare(b.expense.vendor));
}

/** Month -> total spent, for each month in `months`. */
export function expenseTotalsByMonth(expenses: readonly PlatformExpense[], months: readonly string[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const month of months) {
    totals.set(month, expandExpensesForMonth(expenses, month).reduce((sum, o) => sum + o.amountCents, 0));
  }
  return totals;
}

/** Month -> category -> total, for the Categories tab. */
export function expenseTotalsByCategory(occurrences: readonly ExpenseOccurrence[]): Array<{ category: string; cents: number; count: number }> {
  const byCategory = new Map<string, { cents: number; count: number }>();
  for (const o of occurrences) {
    const entry = byCategory.get(o.expense.category) ?? { cents: 0, count: 0 };
    entry.cents += o.amountCents;
    entry.count += 1;
    byCategory.set(o.expense.category, entry);
  }
  return [...byCategory.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.cents - a.cents);
}

/** What a recurring expense costs per month, normalised (yearly / 12, rounded). */
export function monthlyEquivalentCents(expense: Pick<PlatformExpense, "amountCents" | "recurrence">): number {
  if (expense.recurrence === "monthly") return expense.amountCents;
  if (expense.recurrence === "yearly") return Math.round(expense.amountCents / 12);
  return 0;
}

export type RevenueStreams = {
  subscriptions: number;
  credits: number;
  numbers: number;
  serviceFees: number;
};

export const REVENUE_STREAM_LABELS: Record<keyof RevenueStreams, string> = {
  subscriptions: "Subscriptions",
  credits: "Credits",
  numbers: "Numbers",
  serviceFees: "Service fees",
};

export function emptyStreams(): RevenueStreams {
  return { subscriptions: 0, credits: 0, numbers: 0, serviceFees: 0 };
}

export type MonthlyPnl = {
  month: string;
  streams: RevenueStreams;
  /** Sum of the streams, before refunds. */
  grossRevenueCents: number;
  /** Refunds and lost disputes, as a positive number. */
  refundsCents: number;
  /** Gross revenue minus refunds. */
  revenueCents: number;
  stripeFeesCents: number;
  expensesCents: number;
  /** Revenue - Stripe fees - expenses. */
  profitCents: number;
  /** Stripe charges that matched no revenue stream; not counted in revenue. */
  unclassifiedCents: number;
};

/** The one profit formula: revenue (net of refunds) - Stripe fees - expenses. */
export function computeMonthlyPnl(input: {
  month: string;
  streams: RevenueStreams;
  refundsCents?: number;
  stripeFeesCents?: number;
  expensesCents?: number;
  unclassifiedCents?: number;
}): MonthlyPnl {
  const grossRevenueCents =
    input.streams.subscriptions + input.streams.credits + input.streams.numbers + input.streams.serviceFees;
  const refundsCents = input.refundsCents ?? 0;
  const stripeFeesCents = input.stripeFeesCents ?? 0;
  const expensesCents = input.expensesCents ?? 0;
  const revenueCents = grossRevenueCents - refundsCents;
  return {
    month: input.month,
    streams: input.streams,
    grossRevenueCents,
    refundsCents,
    revenueCents,
    stripeFeesCents,
    expensesCents,
    profitCents: revenueCents - stripeFeesCents - expensesCents,
    unclassifiedCents: input.unclassifiedCents ?? 0,
  };
}

export function formatCents(cents: number, options: { signed?: boolean } = {}): string {
  const abs = Math.abs(cents) / 100;
  const text = `$${abs.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
  if (cents < 0) return `−${text}`;
  return options.signed && cents > 0 ? `+${text}` : text;
}

export function formatMonthLabel(month: string, style: "long" | "short" = "long"): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return date.toLocaleDateString("en-US", {
    month: style === "long" ? "long" : "short",
    ...(style === "long" ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}
