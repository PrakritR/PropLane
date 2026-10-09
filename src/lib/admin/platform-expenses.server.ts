import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import {
  EXPENSE_CATEGORY_IDS,
  EXPENSE_RECURRENCES,
  isDateKey,
  isMonthKey,
  type PlatformExpense,
} from "@/lib/admin/platform-expense-rules";

/**
 * PropLane's own expenses (Money > Finances, decision D7: manual entry). Admin-only: callers are the
 * /api/admin/expenses routes after `requireAdminRoute()`, with the service-role client, because the
 * table grants nothing to the browser roles. Receipts live in the private `platform-receipts` bucket
 * and move only through server-minted signed URLs.
 */

export const PLATFORM_RECEIPTS_BUCKET = "platform-receipts";
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
export const RECEIPT_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"] as const;
const RECEIPT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_AMOUNT_CENTS = 100_000_000;
const COLUMNS =
  "id, category, vendor, amount_cents, currency, spent_on, recurrence, ends_on, receipt_path, note, created_at, updated_at";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** `receipts/<uuid>/<file name>` — only paths this module mints are accepted back. */
const RECEIPT_PATH_RE = /^receipts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,120}$/;

export function isPlatformReceiptPath(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_PATH_RE.test(value) && !value.includes("..");
}

const dateKey = z.string().refine(isDateKey, "Use a valid YYYY-MM-DD date.");

const expenseFields = {
  category: z.enum(EXPENSE_CATEGORY_IDS),
  vendor: z.string().trim().min(1, "Vendor is required.").max(120),
  amountCents: z.number().int().min(1, "Amount must be more than $0.").max(MAX_AMOUNT_CENTS),
  spentOn: dateKey,
  recurrence: z.enum(EXPENSE_RECURRENCES).default("none"),
  endsOn: dateKey.nullish(),
  receiptPath: z.string().refine(isPlatformReceiptPath, "Invalid receipt.").nullish(),
  note: z.string().trim().max(500).default(""),
};

function refineExpense(
  input: { spentOn: string; recurrence: string; endsOn?: string | null },
  ctx: z.RefinementCtx,
) {
  if (input.endsOn && input.recurrence === "none") {
    ctx.addIssue({ code: "custom", path: ["endsOn"], message: "A one-time expense has no end date." });
  }
  if (input.endsOn && input.endsOn < input.spentOn) {
    ctx.addIssue({ code: "custom", path: ["endsOn"], message: "The end date is before the first charge." });
  }
}

export const createExpenseSchema = z.object(expenseFields).superRefine(refineExpense);
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z
  .object({ id: z.string().uuid("Invalid expense id.") })
  .extend({
    category: expenseFields.category.optional(),
    vendor: expenseFields.vendor.optional(),
    amountCents: expenseFields.amountCents.optional(),
    spentOn: expenseFields.spentOn.optional(),
    recurrence: z.enum(EXPENSE_RECURRENCES).optional(),
    endsOn: dateKey.nullish(),
    receiptPath: z.string().refine(isPlatformReceiptPath, "Invalid receipt.").nullish(),
    note: z.string().trim().max(500).optional(),
  });
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const deleteExpenseSchema = z.object({ id: z.string().uuid("Invalid expense id.") });

export const receiptUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(RECEIPT_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(RECEIPT_MAX_BYTES, "Receipts are up to 10 MB."),
});

export const expenseRangeSchema = z
  .object({
    from: z.string().refine(isMonthKey, "Use a YYYY-MM month."),
    to: z.string().refine(isMonthKey, "Use a YYYY-MM month."),
  })
  .refine((r) => r.from <= r.to, "The range ends before it starts.")
  .refine((r) => {
    const months = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5)) - Number(r.from.slice(5));
    return months <= 36;
  }, "Pick a range of up to 36 months.");

type ExpenseRow = {
  id: string;
  category: string;
  vendor: string;
  amount_cents: number;
  currency: string;
  spent_on: string;
  recurrence: string;
  ends_on: string | null;
  receipt_path: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export function expenseFromRow(row: ExpenseRow): PlatformExpense {
  return {
    id: row.id,
    category: row.category,
    vendor: row.vendor,
    amountCents: row.amount_cents,
    currency: row.currency,
    spentOn: row.spent_on,
    recurrence: (EXPENSE_RECURRENCES as readonly string[]).includes(row.recurrence)
      ? (row.recurrence as PlatformExpense["recurrence"])
      : "none",
    endsOn: row.ends_on,
    receiptPath: row.receipt_path,
    note: row.note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  return `${month}-${String(new Date(Date.UTC(year, mo, 0)).getUTCDate()).padStart(2, "0")}`;
}

/**
 * Every expense that can charge in the month range: one-time rows dated inside it, plus recurring rows
 * that started by its end and have not ended before its start. The caller expands them into months.
 */
export async function listPlatformExpenses(
  range: { from: string; to: string },
  deps: { db?: Db } = {},
): Promise<PlatformExpense[]> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const fromDay = `${range.from}-01`;
  const { data, error } = await db
    .from("platform_expenses")
    .select(COLUMNS)
    .lte("spent_on", lastDayOfMonth(range.to))
    .or(`ends_on.is.null,ends_on.gte.${fromDay}`)
    .order("spent_on", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as ExpenseRow[])
    .map(expenseFromRow)
    .filter((expense) => expense.recurrence !== "none" || expense.spentOn >= fromDay);
}

export async function createPlatformExpense(
  input: CreateExpenseInput,
  actorUserId: string,
  deps: { db?: Db } = {},
): Promise<PlatformExpense> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("platform_expenses")
    .insert({
      category: input.category,
      vendor: input.vendor,
      amount_cents: input.amountCents,
      currency: "usd",
      spent_on: input.spentOn,
      recurrence: input.recurrence,
      ends_on: input.recurrence === "none" ? null : (input.endsOn ?? null),
      receipt_path: input.receiptPath ?? null,
      note: input.note,
      created_by: actorUserId,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error("Insert returned no row.");
  return expenseFromRow(data as ExpenseRow);
}

export async function getPlatformExpense(id: string, deps: { db?: Db } = {}): Promise<PlatformExpense | null> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db.from("platform_expenses").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? expenseFromRow(data as ExpenseRow) : null;
}

/** Applies a partial edit; the merged row is re-validated as a whole (end date vs. first charge, and so on). */
export async function updatePlatformExpense(
  patch: UpdateExpenseInput,
  deps: { db?: Db } = {},
): Promise<PlatformExpense> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const current = await getPlatformExpense(patch.id, { db });
  if (!current) throw new AdminInputError("That expense no longer exists.", 404);

  const merged = createExpenseSchema.safeParse({
    category: patch.category ?? current.category,
    vendor: patch.vendor ?? current.vendor,
    amountCents: patch.amountCents ?? current.amountCents,
    spentOn: patch.spentOn ?? current.spentOn,
    recurrence: patch.recurrence ?? current.recurrence,
    endsOn: patch.endsOn === undefined ? current.endsOn : patch.endsOn,
    receiptPath: patch.receiptPath === undefined ? current.receiptPath : patch.receiptPath,
    note: patch.note ?? current.note,
  });
  if (!merged.success) throw new AdminInputError(merged.error.issues[0]?.message ?? "Invalid expense.");
  const next = merged.data;

  const { data, error } = await db
    .from("platform_expenses")
    .update({
      category: next.category,
      vendor: next.vendor,
      amount_cents: next.amountCents,
      spent_on: next.spentOn,
      recurrence: next.recurrence,
      ends_on: next.recurrence === "none" ? null : (next.endsOn ?? null),
      receipt_path: next.receiptPath ?? null,
      note: next.note,
    })
    .eq("id", patch.id)
    .select(COLUMNS)
    .single();
  if (error || !data) throw error ?? new Error("Update returned no row.");

  // A replaced or cleared receipt would otherwise sit in the bucket forever.
  if (current.receiptPath && current.receiptPath !== (next.receiptPath ?? null)) {
    await removeReceiptObject(db, current.receiptPath);
  }
  return expenseFromRow(data as ExpenseRow);
}

export async function deletePlatformExpense(id: string, deps: { db?: Db } = {}): Promise<void> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const current = await getPlatformExpense(id, { db });
  if (!current) throw new AdminInputError("That expense no longer exists.", 404);
  const { error } = await db.from("platform_expenses").delete().eq("id", id);
  if (error) throw error;
  if (current.receiptPath) await removeReceiptObject(db, current.receiptPath);
}

async function removeReceiptObject(db: Db, path: string): Promise<void> {
  try {
    await db.storage.from(PLATFORM_RECEIPTS_BUCKET).remove([path]);
  } catch (error) {
    console.error("platform receipt cleanup failed", error);
  }
}

function safeFileName(name: string, mime: string): string {
  const ext = mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/heic" ? "heic" : "jpg";
  const base = name
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${base || "receipt"}.${ext}`;
}

/** A signed upload slot for one receipt. The browser PUTs the bytes straight to Storage with the token. */
export async function createReceiptUpload(
  input: z.infer<typeof receiptUploadSchema>,
  deps: { db?: Db } = {},
): Promise<{ path: string; token: string; bucket: string }> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const path = `receipts/${randomUUID()}/${safeFileName(input.fileName, input.mimeType)}`;
  const { data, error } = await db.storage.from(PLATFORM_RECEIPTS_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.token) throw error ?? new Error("No upload token.");
  return { path, token: data.token, bucket: PLATFORM_RECEIPTS_BUCKET };
}

/** A short-lived link to an expense's receipt. Null when the expense has none. */
export async function getReceiptSignedUrl(id: string, deps: { db?: Db } = {}): Promise<string | null> {
  const db = deps.db ?? createSupabaseServiceRoleClient();
  const expense = await getPlatformExpense(id, { db });
  if (!expense) throw new AdminInputError("That expense no longer exists.", 404);
  if (!expense.receiptPath || !isPlatformReceiptPath(expense.receiptPath)) return null;
  const { data, error } = await db.storage
    .from(PLATFORM_RECEIPTS_BUCKET)
    .createSignedUrl(expense.receiptPath, RECEIPT_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error("No signed URL.");
  return data.signedUrl;
}
