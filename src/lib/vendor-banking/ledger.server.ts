import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { vendorServiceFeeDescription } from "@/lib/platform-fees";

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
] as const;
export type VendorBankingLedgerKind = (typeof VENDOR_BANKING_LEDGER_KINDS)[number];

export const VENDOR_BANKING_LEDGER_SOURCES = [
  "work_order",
  "invoice",
  "withdrawal",
  "refund",
  "hold_expiry",
  "adjustment",
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

/** Every statement line for this vendor, newest first, optionally scoped to a UTC calendar month ("2026-09"). */
export async function listVendorBankingLedgerEntries(
  db: SupabaseClient,
  vendorUserId: string,
  opts: { month?: string | null; limit?: number } = {},
): Promise<VendorBankingLedgerEntry[]> {
  let query = db
    .from("vendor_banking_ledger_entries")
    .select("id, vendor_user_id, manager_user_id, kind, amount_cents, source, source_id, description, stripe_object_id, created_at")
    .eq("vendor_user_id", vendorUserId)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 1000);
  if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
    const start = `${opts.month}-01T00:00:00.000Z`;
    const [y, m] = opts.month.split("-").map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const end = `${nextMonth}-01T00:00:00.000Z`;
    query = query.gte("created_at", start).lt("created_at", end);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Could not read the vendor banking ledger: ${error.message}`);
  return (data ?? []).map((row) => fromRow(row as LedgerRow));
}

/** Running total across every ledger line for this vendor — the reconciliation job's "our side" number. */
export async function sumVendorBankingLedgerCents(db: SupabaseClient, vendorUserId: string): Promise<number> {
  const { data, error } = await db
    .from("vendor_banking_ledger_entries")
    .select("amount_cents")
    .eq("vendor_user_id", vendorUserId);
  if (error) throw new Error(`Could not sum the vendor banking ledger: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + (Number((row as { amount_cents: number }).amount_cents) || 0), 0);
}

/** Every vendor with at least one ledger line — the reconciliation cron's fan-out list. */
export async function listVendorUserIdsWithLedgerActivity(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("vendor_banking_ledger_entries").select("vendor_user_id");
  if (error) throw new Error(`Could not list vendor banking ledger vendors: ${error.message}`);
  return [...new Set((data ?? []).map((row) => String((row as { vendor_user_id: string }).vendor_user_id)))];
}
