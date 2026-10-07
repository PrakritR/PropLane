import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { vendorServiceFeeDescription } from "@/lib/platform-fees";
import { pacificMonthWindow } from "@/lib/vendor-banking/statement-events";

/**
 * Every statement line kind vendor banking ever writes. `charge` and
 * `platform_fee` are always a matched pair (gross credit, fee debit) written
 * next to the DB write that settles a payment — the same write-through
 * discipline `ledger-sync.ts` documents for the manager-side GL: this table
 * is a record of what already happened, never itself a source of new money.
 */
export const VENDOR_BANKING_LEDGER_KINDS = [
  "charge",
  "platform_fee",
  "hold",
  "transfer",
  "withdrawal",
  "refund",
  "adjustment",
  "dispute",
] as const;
export type VendorBankingLedgerKind = (typeof VENDOR_BANKING_LEDGER_KINDS)[number];

export const VENDOR_BANKING_LEDGER_SOURCES = [
  "work_order",
  "invoice",
  "withdrawal",
  "refund",
  "hold_expiry",
  "adjustment",
  "dispute",
] as const;
export type VendorBankingLedgerSource = (typeof VENDOR_BANKING_LEDGER_SOURCES)[number];

export type VendorBankingLedgerEntry = {
  id: string;
  vendorUserId: string;
  managerUserId: string | null;
  kind: VendorBankingLedgerKind;
  amountCents: number;
  source: VendorBankingLedgerSource;
  sourceId: string | null;
  description: string;
  stripeObjectId: string | null;
  createdAt: string;
};

type LedgerRow = {
  id: string;
  vendor_user_id: string;
  manager_user_id: string | null;
  kind: string;
  amount_cents: number;
  source: string;
  source_id: string | null;
  description: string;
  stripe_object_id: string | null;
  created_at: string;
};

function fromRow(row: LedgerRow): VendorBankingLedgerEntry {
  return {
    id: row.id,
    vendorUserId: row.vendor_user_id,
    managerUserId: row.manager_user_id,
    kind: row.kind as VendorBankingLedgerKind,
    amountCents: Number(row.amount_cents) || 0,
    source: row.source as VendorBankingLedgerSource,
    sourceId: row.source_id,
    description: row.description,
    stripeObjectId: row.stripe_object_id,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key|unique constraint/i.test(error.message ?? "");
}

/**
 * Appends one signed statement line. Idempotent on `idempotencyKey` when
 * given — a webhook redelivery or a retried request is a no-op, never a
 * double-post. Positive `amountCents` credits the vendor (money in/available
 * to them); negative debits (fee retained, withdrawal sent, refund clawed
 * back).
 */
export async function recordVendorBankingLedgerEntry(
  db: SupabaseClient,
  opts: {
    vendorUserId: string;
    managerUserId?: string | null;
    kind: VendorBankingLedgerKind;
    amountCents: number;
    source: VendorBankingLedgerSource;
    sourceId?: string | null;
    description: string;
    stripeObjectId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ ok: true; alreadyRecorded: boolean; entryId: string | null }> {
  const amountCents = Math.round(opts.amountCents);
  if (!Number.isFinite(amountCents) || amountCents === 0) {
    return { ok: true, alreadyRecorded: false, entryId: null };
  }
  const { data, error } = await db
    .from("vendor_banking_ledger_entries")
    .insert({
      vendor_user_id: opts.vendorUserId,
      manager_user_id: opts.managerUserId ?? null,
      kind: opts.kind,
      amount_cents: amountCents,
      source: opts.source,
      source_id: opts.sourceId ?? null,
      description: opts.description,
      stripe_object_id: opts.stripeObjectId ?? null,
      idempotency_key: opts.idempotencyKey ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) return { ok: true, alreadyRecorded: true, entryId: null };
    throw new Error(`Could not record vendor banking ledger entry: ${error.message}`);
  }
  return { ok: true, alreadyRecorded: false, entryId: (data as { id: string } | null)?.id ?? null };
}

/** Convenience: write the matched charge (gross credit) + platform_fee (debit) pair for one settled payment. */
export async function recordVendorBankingChargeAndFee(
  db: SupabaseClient,
  opts: {
    vendorUserId: string;
    managerUserId?: string | null;
    grossCents: number;
    feeCents: number;
    source: VendorBankingLedgerSource;
    sourceId: string;
    description: string;
    stripeObjectId?: string | null;
  },
): Promise<void> {
  if (opts.grossCents > 0) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: opts.vendorUserId,
      managerUserId: opts.managerUserId,
      kind: "charge",
      amountCents: opts.grossCents,
      source: opts.source,
      sourceId: opts.sourceId,
      description: opts.description,
      stripeObjectId: opts.stripeObjectId,
      idempotencyKey: `${opts.source}:${opts.sourceId}:charge`,
    });
  }
  if (opts.feeCents > 0) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: opts.vendorUserId,
      managerUserId: opts.managerUserId,
      kind: "platform_fee",
      amountCents: -Math.abs(opts.feeCents),
      source: opts.source,
      sourceId: opts.sourceId,
      description: vendorServiceFeeDescription(),
      stripeObjectId: opts.stripeObjectId,
      idempotencyKey: `${opts.source}:${opts.sourceId}:platform_fee`,
    });
  }
}

/**
 * PostgREST caps a single response (Supabase's default is 1,000 rows), so every
 * read here pages to the end instead of taking one capped page. A statement or a
 * 1099 total that silently stops at the cap is a WRONG number, not a short list.
 */
const LEDGER_PAGE_SIZE = 1000;

type PagedQuery = {
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Read every row the builder matches, one page at a time. `build()` must return a freshly ordered query. */
async function readAllLedgerPages<T>(build: () => PagedQuery, failure: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += LEDGER_PAGE_SIZE) {
    const { data, error } = await build().range(from, from + LEDGER_PAGE_SIZE - 1);
    if (error) throw new Error(`${failure}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < LEDGER_PAGE_SIZE) return out;
  }
}

/**
 * Every statement line for this vendor, OLDEST first (a running balance is only
 * meaningful in order), optionally scoped to one Pacific calendar month
 * ("2026-09") — the same month boundary `statementMonthKey` buckets on.
 *
 * There is deliberately no row cap: the caller gets the whole ledger or an
 * error, never a truncated one that reads as a complete statement.
 */
export async function listVendorBankingLedgerEntries(
  db: SupabaseClient,
  vendorUserId: string,
  opts: { month?: string | null } = {},
): Promise<VendorBankingLedgerEntry[]> {
  const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : null;
  const window = month ? pacificMonthWindow(month) : null;
  const rows = await readAllLedgerPages<LedgerRow>(() => {
    let query = db
      .from("vendor_banking_ledger_entries")
      .select("id, vendor_user_id, manager_user_id, kind, amount_cents, source, source_id, description, stripe_object_id, created_at")
      .eq("vendor_user_id", vendorUserId)
      // `created_at` alone is not unique, and a page boundary inside a tie
      // would drop or repeat a line; `id` makes the order total.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (window) query = query.gte("created_at", window.start).lt("created_at", window.end);
    return query as unknown as PagedQuery;
  }, "Could not read the vendor banking ledger");
  return rows.map((row) => fromRow(row));
}

/** Running total across every ledger line for this vendor — the reconciliation job's "our side" number. */
export async function sumVendorBankingLedgerCents(db: SupabaseClient, vendorUserId: string): Promise<number> {
  const rows = await readAllLedgerPages<{ amount_cents: number; id: string }>(
    () =>
      db
        .from("vendor_banking_ledger_entries")
        .select("id, amount_cents")
        .eq("vendor_user_id", vendorUserId)
        .order("id", { ascending: true }) as unknown as PagedQuery,
    "Could not sum the vendor banking ledger",
  );
  return rows.reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
}

/** Every vendor with at least one ledger line — the reconciliation cron's fan-out list. */
export async function listVendorUserIdsWithLedgerActivity(db: SupabaseClient): Promise<string[]> {
  const rows = await readAllLedgerPages<{ vendor_user_id: string; id: string }>(
    () =>
      db
        .from("vendor_banking_ledger_entries")
        .select("id, vendor_user_id")
        .order("id", { ascending: true }) as unknown as PagedQuery,
    "Could not list vendor banking ledger vendors",
  );
  return [...new Set(rows.map((row) => String(row.vendor_user_id)))];
}
