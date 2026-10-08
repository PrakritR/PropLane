/**
 * Vendor expenses (Outgoing payments, vendor-portal-ia-1007): what a vendor spends to do the work.
 * Client-safe and pure — types, the category list, input validation and the date buckets the
 * three tabs read. The rows live in `vendor_expense_entries`, private to the vendor.
 */

export const VENDOR_EXPENSE_CATEGORIES = [
  { id: "materials", label: "Materials" },
  { id: "tools", label: "Tools & equipment" },
  { id: "subcontractor", label: "Subcontractor" },
  { id: "fuel_travel", label: "Fuel & travel" },
  { id: "permits_fees", label: "Permits & fees" },
  { id: "other", label: "Other" },
] as const;

export type VendorExpenseCategory = (typeof VENDOR_EXPENSE_CATEGORIES)[number]["id"];

export function isVendorExpenseCategory(value: unknown): value is VendorExpenseCategory {
  return VENDOR_EXPENSE_CATEGORIES.some((category) => category.id === value);
}

export function vendorExpenseCategoryLabel(id: string): string {
  return VENDOR_EXPENSE_CATEGORIES.find((category) => category.id === id)?.label ?? "Other";
}

/** What the client reads. The receipt's storage path never leaves the server. */
export type VendorExpense = {
  id: string;
  expenseDate: string;
  amountCents: number;
  category: VendorExpenseCategory;
  memo: string | null;
  workOrderId: string | null;
  /** The linked service's title and place, read from the vendor's own service record. */
  workOrderTitle: string | null;
  propertyLabel: string | null;
  hasReceipt: boolean;
  createdAt: string;
};

export const VENDOR_EXPENSE_MAX_CENTS = 100_000_000; // $1,000,000.00
export const VENDOR_EXPENSE_MEMO_MAX = 500;

export type VendorExpenseInput = {
  expenseDate: string;
  amountCents: number;
  category: VendorExpenseCategory;
  memo: string | null;
  /** `undefined` leaves the link alone (PATCH); `null` clears it. */
  workOrderId: string | null | undefined;
};

export type VendorExpenseParse<T> = { ok: true; value: T } | { ok: false; error: string };

function validDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/**
 * Validates an expense body. A caller-supplied `vendor_user_id` / `vendorUserId` is never read —
 * the owner is the signed-in user, set by the route. With `partial` (PATCH) absent fields stay out
 * of the result so they are not overwritten.
 */
export function parseVendorExpenseBody(
  body: unknown,
  opts: { partial: boolean },
): VendorExpenseParse<Partial<VendorExpenseInput>> {
  if (!body || typeof body !== "object") return { ok: false, error: "Send the expense as JSON." };
  const raw = body as Record<string, unknown>;
  const out: Partial<VendorExpenseInput> = {};

  if (raw.amountCents !== undefined || !opts.partial) {
    const cents = raw.amountCents;
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) {
      return { ok: false, error: "Enter an amount greater than zero." };
    }
    if (cents > VENDOR_EXPENSE_MAX_CENTS) return { ok: false, error: "That amount is too large." };
    out.amountCents = cents;
  }
  if (raw.expenseDate !== undefined || !opts.partial) {
    const date = validDate(raw.expenseDate);
    if (!date) return { ok: false, error: "Choose a valid date." };
    out.expenseDate = date;
  }
  if (raw.category !== undefined || !opts.partial) {
    if (!isVendorExpenseCategory(raw.category)) return { ok: false, error: "Choose a category." };
    out.category = raw.category;
  }
  if (raw.memo !== undefined) {
    if (raw.memo !== null && typeof raw.memo !== "string") return { ok: false, error: "The note must be text." };
    const memo = typeof raw.memo === "string" ? raw.memo.trim() : "";
    if (memo.length > VENDOR_EXPENSE_MEMO_MAX) {
      return { ok: false, error: `Keep the note under ${VENDOR_EXPENSE_MEMO_MAX} characters.` };
    }
    out.memo = memo || null;
  } else if (!opts.partial) {
    out.memo = null;
  }
  if (raw.workOrderId !== undefined) {
    if (raw.workOrderId !== null && typeof raw.workOrderId !== "string") {
      return { ok: false, error: "Choose one of your services." };
    }
    const id = typeof raw.workOrderId === "string" ? raw.workOrderId.trim() : "";
    out.workOrderId = id || null;
  } else if (!opts.partial) {
    out.workOrderId = null;
  }
  return { ok: true, value: out };
}

export type VendorExpenseSegment = "this-month" | "last-month" | "earlier";

/** yyyy-mm of a yyyy-mm-dd date, or "" when malformed. */
function monthKey(day: string): string {
  return /^\d{4}-\d{2}/.test(day) ? day.slice(0, 7) : "";
}

/** The month key `delta` months before `today`'s month (today is yyyy-mm-dd on the vendor's clock). */
function shiftMonth(today: string, delta: number): string {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const index = (y ?? 0) * 12 + ((m ?? 1) - 1) - delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** This month, last month, or earlier (anything older, plus any date in the future is "this month"). */
export function vendorExpenseSegment(expenseDate: string, today: string): VendorExpenseSegment {
  const key = monthKey(expenseDate);
  const thisMonth = monthKey(today);
  if (!key || key >= thisMonth) return "this-month";
  if (key === shiftMonth(today, 1)) return "last-month";
  return "earlier";
}

export function vendorExpenseSegmentCounts(
  expenses: readonly Pick<VendorExpense, "expenseDate">[],
  today: string,
): Record<VendorExpenseSegment, number> {
  const counts: Record<VendorExpenseSegment, number> = { "this-month": 0, "last-month": 0, earlier: 0 };
  for (const expense of expenses) counts[vendorExpenseSegment(expense.expenseDate, today)] += 1;
  return counts;
}

/** yyyy-mm-dd on the vendor's own clock. */
export function todayLocalIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "12.5" -> 1250. Null when it is not a positive amount with at most two decimals. */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, cents = ""] = (cleaned.split(".") as [string, string?]);
  const total = Number(dollars) * 100 + Number((cents ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The expenses as CSV (Download on Outgoing payments). Dollars come from integer cents, never floats. */
export function vendorExpensesCsv(expenses: readonly VendorExpense[]): string {
  const header = ["Date", "Category", "Amount", "Service", "Property", "Note", "Receipt"];
  const lines = expenses.map((expense) =>
    [
      expense.expenseDate,
      vendorExpenseCategoryLabel(expense.category),
      `${Math.floor(expense.amountCents / 100)}.${String(expense.amountCents % 100).padStart(2, "0")}`,
      expense.workOrderTitle ?? "",
      expense.propertyLabel ?? "",
      expense.memo ?? "",
      expense.hasReceipt ? "Yes" : "No",
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

/** Receipts: images and PDFs, 5 MB at most (the same limits as the vendor's other private uploads). */
export const VENDOR_EXPENSE_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const VENDOR_EXPENSE_RECEIPT_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
