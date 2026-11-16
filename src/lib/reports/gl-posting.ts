import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";

export type GlSourceType =
  | "charge"
  | "payment"
  | "refund"
  | "expense"
  | "bill"
  | "deposit_receipt"
  | "deposit_refund"
  | "owner_distribution"
  | "payout"
  | "stripe_fee"
  | "manual"
  | "adjustment";

export type GlJournalLineInput = {
  accountCode: string;
  debitCents: number;
  creditCents: number;
  propertyId?: string | null;
  residentUserId?: string | null;
  vendorId?: string | null;
  memo?: string | null;
};

type PostJournalInput = {
  managerUserId: string;
  propertyId?: string | null;
  entryDate: string;
  memo?: string | null;
  sourceType: GlSourceType;
  sourceId: string;
  lines: GlJournalLineInput[];
  linkLedgerEntryId?: string | null;
};

const AR_ACCOUNT = "accounts_receivable";
const AP_ACCOUNT = "accounts_payable";

function assertBalanced(lines: GlJournalLineInput[]): void {
  const debits = lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credits = lines.reduce((sum, line) => sum + line.creditCents, 0);
  if (debits !== credits) {
    throw new Error(`GL journal unbalanced: debits=${debits} credits=${credits}`);
  }
  if (debits <= 0) throw new Error("GL journal must have a positive total.");
}

function cashAccountForCategory(categoryCode: string): string {
  return categoryCode === "security_deposit_liability" ? "trust_account_security_deposits" : "operating_cash";
}

async function journalEntryExists(
  db: SupabaseClient,
  managerUserId: string,
  sourceType: GlSourceType,
  sourceId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("gl_journal_entries")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .eq("is_reversal", false)
    .maybeSingle();
  if (error) throw new Error(`GL lookup failed: ${error.message}`);
  return data?.id ? String(data.id) : null;
}

async function waitForJournalEntryLines(db: SupabaseClient, journalEntryId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await db
      .from("gl_journal_lines")
      .select("id")
      .eq("journal_entry_id", journalEntryId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`GL journal lines lookup failed: ${error.message}`);
    if (data?.id) return true;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function retryIncompleteJournalEntry(
  db: SupabaseClient,
  input: PostJournalInput,
  journalEntryId: string,
  recoveryAttempt: number,
): Promise<string> {
  if (recoveryAttempt > 0) {
    throw new Error("GL journal exists without lines after recovery; retry posting.");
  }
  const { error } = await db.from("gl_journal_entries").delete().eq("id", journalEntryId);
  if (error) throw new Error(`Incomplete GL journal cleanup failed: ${error.message}`);
  return insertJournalEntry(db, input, recoveryAttempt + 1);
}

async function insertJournalEntry(
  db: SupabaseClient,
  input: PostJournalInput,
  recoveryAttempt = 0,
): Promise<string> {
  assertBalanced(input.lines);

  const existingId = await journalEntryExists(db, input.managerUserId, input.sourceType, input.sourceId);
  if (existingId) {
    if (await waitForJournalEntryLines(db, existingId)) return existingId;
    return retryIncompleteJournalEntry(db, input, existingId, recoveryAttempt);
  }

  const now = new Date().toISOString();
  const { data: entry, error: entryError } = await db
    .from("gl_journal_entries")
    .insert({
      manager_user_id: input.managerUserId,
      property_id: input.propertyId ?? null,
      entry_date: input.entryDate,
      memo: input.memo ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId,
      updated_at: now,
    })
    .select("id")
    .single();

  if (entryError || !entry?.id) {
    const concurrentEntryId = await journalEntryExists(
      db,
      input.managerUserId,
      input.sourceType,
      input.sourceId,
    );
    if (concurrentEntryId) {
      if (await waitForJournalEntryLines(db, concurrentEntryId)) return concurrentEntryId;
      return retryIncompleteJournalEntry(db, input, concurrentEntryId, recoveryAttempt);
    }
    throw new Error(`GL journal insert failed: ${entryError?.message ?? "unknown"}`);
  }

  const journalEntryId = String(entry.id);
  const lineRows = input.lines.map((line) => ({
    journal_entry_id: journalEntryId,
    account_code: line.accountCode,
    debit_cents: line.debitCents,
    credit_cents: line.creditCents,
    property_id: line.propertyId ?? input.propertyId ?? null,
    resident_user_id: line.residentUserId ?? null,
    vendor_id: line.vendorId ?? null,
    memo: line.memo ?? null,
  }));

  const { error: linesError } = await db.from("gl_journal_lines").insert(lineRows);
  if (linesError) {
    await db.from("gl_journal_entries").delete().eq("id", journalEntryId);
    throw new Error(`GL journal lines insert failed: ${linesError.message}`);
  }

  if (input.linkLedgerEntryId) {
    await db
      .from("ledger_entries")
      .update({ gl_journal_entry_id: journalEntryId, updated_at: now })
      .eq("id", input.linkLedgerEntryId)
      .then(({ error }) => {
        if (error) throw new Error(`GL ledger link failed: ${error.message}`);
      });
  }

  return journalEntryId;
}

export type GlChargeInput = {
  managerUserId: string;
  sourceChargeId: string;
  categoryCode: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  residentUserId?: string | null;
  description?: string | null;
  linkLedgerEntryId?: string | null;
};

export async function postGlChargeEntry(db: SupabaseClient, input: GlChargeInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.description ?? `Charge ${input.sourceChargeId}`,
    sourceType: "charge",
    sourceId: input.sourceChargeId,
    linkLedgerEntryId: input.linkLedgerEntryId,
    lines: [
      {
        accountCode: AR_ACCOUNT,
        debitCents: input.amountCents,
        creditCents: 0,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
      {
        accountCode: input.categoryCode,
        debitCents: 0,
        creditCents: input.amountCents,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
    ],
  });
}

export type GlPaymentInput = {
  managerUserId: string;
  sourceChargeId: string;
  categoryCode: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  residentUserId?: string | null;
  description?: string | null;
  linkLedgerEntryId?: string | null;
};

export async function postGlPaymentEntry(db: SupabaseClient, input: GlPaymentInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;

  const cashAccount = cashAccountForCategory(input.categoryCode);

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.description ?? `Payment ${input.sourceChargeId}`,
    sourceType: "payment",
    sourceId: input.sourceChargeId,
    linkLedgerEntryId: input.linkLedgerEntryId,
    lines: [
      {
        accountCode: cashAccount,
        debitCents: input.amountCents,
        creditCents: 0,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
      {
        accountCode: AR_ACCOUNT,
        debitCents: 0,
        creditCents: input.amountCents,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
    ],
  });
}

export type GlExpenseInput = {
  managerUserId: string;
  expenseId: string;
  categoryCode: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  vendorId?: string | null;
  memo?: string | null;
};

/** Cash income without an associated receivable (e.g. reviewed historical property income). */
export async function postGlManualIncomeEntry(db: SupabaseClient, input: GlPaymentInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;
  return insertJournalEntry(db, {
    managerUserId: input.managerUserId, propertyId: input.propertyId,
    entryDate: input.entryDate, memo: input.description, sourceType: "manual", sourceId: input.sourceChargeId,
    linkLedgerEntryId: input.linkLedgerEntryId,
    lines: [
      { accountCode: cashAccountForCategory(input.categoryCode), debitCents: input.amountCents, creditCents: 0, propertyId: input.propertyId },
      { accountCode: input.categoryCode, debitCents: 0, creditCents: input.amountCents, propertyId: input.propertyId },
    ],
  });
}

export async function postGlExpenseEntry(db: SupabaseClient, input: GlExpenseInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? `Expense ${input.expenseId}`,
    sourceType: "expense",
    sourceId: input.expenseId,
    lines: [
      {
        accountCode: input.categoryCode,
        debitCents: input.amountCents,
        creditCents: 0,
        propertyId: input.propertyId,
        vendorId: input.vendorId,
        memo: input.memo,
      },
      {
        accountCode: "operating_cash",
        debitCents: 0,
        creditCents: input.amountCents,
        propertyId: input.propertyId,
        vendorId: input.vendorId,
        memo: input.memo,
      },
    ],
  });
}

export type GlVendorRefundReversalInput = {
  managerUserId: string;
  /** The central refund's stable attempt key: the journal is idempotent on it. */
  attemptKey: string;
  categoryCode: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  vendorId?: string | null;
  memo?: string | null;
};

/** A vendor sent a manager's payment back: DR operating cash, CR the expense category it was booked to. */
export async function postGlVendorRefundReversal(
  db: SupabaseClient,
  input: GlVendorRefundReversalInput,
): Promise<string | null> {
  if (input.amountCents <= 0) return null;
  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? `Vendor refund ${input.attemptKey}`,
    sourceType: "refund",
    sourceId: `vendor-refund:${input.attemptKey}`,
    lines: [
      { accountCode: "operating_cash", debitCents: input.amountCents, creditCents: 0, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
      { accountCode: input.categoryCode, debitCents: 0, creditCents: input.amountCents, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
    ],
  });
}

export type GlDepositDispositionInput = {
  managerUserId: string;
  sourceId: string;
  entryDate: string;
  refundCents: number;
  withholdCents: number;
  propertyId?: string | null;
  residentUserId?: string | null;
  memo?: string | null;
};

/** Deposit move-out: DR liability, CR trust cash (refund) and/or income (withhold). */
export async function postGlDepositDisposition(
  db: SupabaseClient,
  input: GlDepositDispositionInput,
): Promise<string | null> {
  const refundCents = Math.max(0, Math.round(input.refundCents));
  const withholdCents = Math.max(0, Math.round(input.withholdCents));
  const total = refundCents + withholdCents;
  if (total <= 0) return null;

  const lines: GlJournalLineInput[] = [
    {
      accountCode: "security_deposit_liability",
      debitCents: total,
      creditCents: 0,
      propertyId: input.propertyId,
      residentUserId: input.residentUserId,
      memo: input.memo,
    },
  ];
  if (refundCents > 0) {
    lines.push({
      accountCode: "trust_account_security_deposits",
      debitCents: 0,
      creditCents: refundCents,
      propertyId: input.propertyId,
      residentUserId: input.residentUserId,
      memo: input.memo,
    });
  }
  if (withholdCents > 0) {
    lines.push({
      accountCode: "other_income",
      debitCents: 0,
      creditCents: withholdCents,
      propertyId: input.propertyId,
      residentUserId: input.residentUserId,
      memo: input.memo,
    });
  }

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? "Security deposit disposition",
    sourceType: "deposit_refund",
    sourceId: input.sourceId,
    lines,
  });
}

export type GlReclassifyDepositInput = {
  managerUserId: string;
  sourceId: string;
  entryDate: string;
  amountCents: number;
  propertyId?: string | null;
  residentUserId?: string | null;
  memo?: string | null;
};

/** Historical fix: DR misclassified income / CR deposit liability (current-dated). */
export async function postGlReclassifyDeposit(
  db: SupabaseClient,
  input: GlReclassifyDepositInput,
): Promise<string | null> {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  if (amountCents <= 0) return null;

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? "Security deposit reclassification",
    sourceType: "adjustment",
    sourceId: input.sourceId,
    lines: [
      {
        accountCode: "other_income",
        debitCents: amountCents,
        creditCents: 0,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.memo,
      },
      {
        accountCode: "security_deposit_liability",
        debitCents: 0,
        creditCents: amountCents,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.memo,
      },
    ],
  });
}

export type GlBillInput = {
  managerUserId: string;
  billId: string;
  amountCents: number;
  entryDate: string;
  categoryCode: string;
  propertyId?: string | null;
  vendorId?: string | null;
  memo?: string | null;
};

export async function postGlBillApproved(db: SupabaseClient, input: GlBillInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;
  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? `Bill approved ${input.billId}`,
    sourceType: "bill",
    sourceId: `bill-approve:${input.billId}`,
    lines: [
      { accountCode: input.categoryCode, debitCents: input.amountCents, creditCents: 0, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
      { accountCode: AP_ACCOUNT, debitCents: 0, creditCents: input.amountCents, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
    ],
  });
}

export async function postGlBillVoided(db: SupabaseClient, input: GlBillInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;
  return insertJournalEntry(db, {
    managerUserId: input.managerUserId, propertyId: input.propertyId, entryDate: input.entryDate,
    memo: input.memo ?? "Bill voided", sourceType: "bill", sourceId: `bill-void:${input.billId}`,
    lines: [
      { accountCode: AP_ACCOUNT, debitCents: input.amountCents, creditCents: 0, propertyId: input.propertyId, vendorId: input.vendorId },
      { accountCode: input.categoryCode, debitCents: 0, creditCents: input.amountCents, propertyId: input.propertyId, vendorId: input.vendorId },
    ],
  });
}

export async function postGlBillPaid(db: SupabaseClient, input: GlBillInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;
  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? `Bill paid ${input.billId}`,
    sourceType: "bill",
    sourceId: `bill-pay:${input.billId}`,
    lines: [
      { accountCode: AP_ACCOUNT, debitCents: input.amountCents, creditCents: 0, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
      { accountCode: "operating_cash", debitCents: 0, creditCents: input.amountCents, propertyId: input.propertyId, vendorId: input.vendorId, memo: input.memo },
    ],
  });
}

export type GlOwnerDistributionInput = {
  managerUserId: string;
  sourceId: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  memo?: string | null;
};

/** Pay an owner: DR owner's equity (draw) / CR operating cash. */
export async function postGlOwnerDistribution(
  db: SupabaseClient,
  input: GlOwnerDistributionInput,
): Promise<string | null> {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  if (amountCents <= 0) return null;

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.memo ?? "Owner distribution",
    sourceType: "owner_distribution",
    sourceId: input.sourceId,
    lines: [
      { accountCode: "owners_equity", debitCents: amountCents, creditCents: 0, propertyId: input.propertyId, memo: input.memo },
      { accountCode: "operating_cash", debitCents: 0, creditCents: amountCents, propertyId: input.propertyId, memo: input.memo },
    ],
  });
}

export type GlRefundInput = {
  managerUserId: string;
  sourceChargeId: string;
  stripeRefundId: string;
  categoryCode: string;
  amountCents: number;
  entryDate: string;
  propertyId?: string | null;
  residentUserId?: string | null;
  description?: string | null;
  linkLedgerEntryId?: string | null;
};

/** Reverse a collected payment: DR income/liability, CR cash. */
export async function postGlRefundEntry(db: SupabaseClient, input: GlRefundInput): Promise<string | null> {
  if (input.amountCents <= 0) return null;

  const cashAccount = cashAccountForCategory(input.categoryCode);

  return insertJournalEntry(db, {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    entryDate: input.entryDate,
    memo: input.description ?? `Refund ${input.stripeRefundId}`,
    sourceType: "refund",
    sourceId: `refund:${input.sourceChargeId}:${input.stripeRefundId}`,
    linkLedgerEntryId: input.linkLedgerEntryId,
    lines: [
      {
        accountCode: input.categoryCode,
        debitCents: input.amountCents,
        creditCents: 0,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
      {
        accountCode: cashAccount,
        debitCents: 0,
        creditCents: input.amountCents,
        propertyId: input.propertyId,
        residentUserId: input.residentUserId,
        memo: input.description,
      },
    ],
  });
}

/** Convenience wrapper when posting from a household charge mirror. */
export async function postGlFromHouseholdCharge(
  db: SupabaseClient,
  charge: HouseholdCharge,
  entryType: "charge" | "payment",
  opts?: { paidAt?: string | null; linkLedgerEntryId?: string | null },
): Promise<string | null> {
  const managerUserId = charge.managerUserId;
  if (!managerUserId) return null;

  const categoryCode = categoryCodeForChargeKind(charge.kind);
  const amountCents = Math.round(parseMoney(charge.status === "paid" ? charge.amountLabel : charge.balanceLabel || charge.amountLabel) * 100);
  if (amountCents <= 0) return null;

  const entryDate =
    (entryType === "payment" ? opts?.paidAt ?? charge.paidAt : charge.createdAt)?.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  const base = {
    managerUserId,
    sourceChargeId: charge.id,
    categoryCode,
    amountCents,
    entryDate,
    propertyId: charge.propertyId,
    residentUserId: charge.residentUserId,
    description: entryType === "payment" ? `Payment — ${charge.title}` : charge.title,
    linkLedgerEntryId: opts?.linkLedgerEntryId,
  };

  return entryType === "payment" ? postGlPaymentEntry(db, base) : postGlChargeEntry(db, base);
}

function parseMoney(raw: string | null | undefined): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

type LedgerMirrorRow = {
  id: string;
  manager_user_id: string | null;
  resident_user_id: string | null;
  property_id: string | null;
  entry_type: "charge" | "payment";
  category_code: string;
  amount_cents: number;
  posted_date: string | null;
  source_charge_id: string | null;
  description: string | null;
};


/**
 * Historical repair — sweep existing ledger/expense rows into GL. Never called
 * from report routes; exposed via admin-gated /api/admin/backfill-gl.
 */
export async function backfillGlFromSources(
  db: SupabaseClient,
  managerUserId?: string,
): Promise<{ posted: number; skipped: number }> {
  let posted = 0;
  let skipped = 0;

  let ledgerQuery = db
    .from("ledger_entries")
    .select(
      "id, manager_user_id, resident_user_id, property_id, entry_type, category_code, amount_cents, posted_date, source_charge_id, description",
    )
    .order("posted_date", { ascending: true })
    .limit(4000);
  if (managerUserId) ledgerQuery = ledgerQuery.eq("manager_user_id", managerUserId);

  const { data: ledgerRows, error: ledgerError } = await ledgerQuery;
  if (ledgerError) throw new Error(ledgerError.message);

  for (const row of (ledgerRows as LedgerMirrorRow[] | null) ?? []) {
    if (!row.manager_user_id || !row.source_charge_id || row.amount_cents <= 0) {
      skipped++;
      continue;
    }
    const entryDate = row.posted_date ?? new Date().toISOString().slice(0, 10);
    const base = {
      managerUserId: row.manager_user_id,
      categoryCode: row.category_code,
      amountCents: Number(row.amount_cents),
      entryDate,
      propertyId: row.property_id,
      residentUserId: row.resident_user_id,
      description: row.description,
      linkLedgerEntryId: row.id,
    };

    const sourceId = row.source_charge_id;
    const exists =
      row.entry_type === "payment"
        ? await journalEntryExists(db, row.manager_user_id, "payment", sourceId)
        : await journalEntryExists(db, row.manager_user_id, "charge", sourceId);
    if (exists) {
      skipped++;
      continue;
    }

    if (row.entry_type === "payment") {
      await postGlPaymentEntry(db, { ...base, sourceChargeId: sourceId });
    } else {
      await postGlChargeEntry(db, { ...base, sourceChargeId: sourceId });
    }
    posted++;
  }

  // Manual expenses and manual income (no source charge, so the ledger sweep above skips it) go through one repair.
  const manual = await repairManualEntryGl(db, { managerUserId });
  posted += manual.posted;
  skipped += manual.skipped;

  return { posted, skipped };
}

/**
 * Remove the (non-reversal) journal of a source whose own row is being edited or hard-deleted. Only for
 * mirrors of editable bookkeeping rows (a manual expense or manual income entry): the source row is
 * replaced or gone, so its journal follows it. Lines go with the entry (cascade). Money that actually
 * moved (charges, payments, refunds) is never removed this way: it is reversed with `reverseGlJournalForSource`.
 */
export async function deleteGlJournalForSource(
  db: SupabaseClient,
  input: { managerUserId: string; sourceType: GlSourceType; sourceId: string },
): Promise<boolean> {
  const id = await journalEntryExists(db, input.managerUserId, input.sourceType, input.sourceId);
  if (!id) return false;
  const { error } = await db.from("gl_journal_entries").delete().eq("id", id).eq("manager_user_id", input.managerUserId);
  if (error) throw new Error(`GL journal delete failed: ${error.message}`);
  return true;
}

/** The slice of a `manager_expense_entries` row the GL needs. */
export type ExpenseGlRow = {
  id: string;
  manager_user_id: string;
  property_id: string | null;
  category_code: string;
  amount_cents: number | string;
  expense_date: string;
  memo: string | null;
  vendor_id: string | null;
  payment_status?: string | null;
  due_date?: string | null;
  paid_date?: string | null;
};

/** Source id of the accrual / settlement journals of a bill-style expense: one id space with real bills never collides. */
function expenseBillId(expenseId: string): string {
  return `exp:${expenseId}`;
}

/**
 * Post the journal(s) one expense row implies, idempotently (each journal is keyed by the row id):
 *  - no due date: a cash expense, DR expense / CR operating cash (`postGlExpenseEntry`);
 *  - a due date: the bill is an accrual, DR expense / CR accounts payable on the bill date, and once the row is
 *    Paid the settlement, DR accounts payable / CR operating cash, on the paid date.
 * A Due row therefore already counts on the P&L (accrual) while cash stays untouched until it is paid.
 */
export async function postExpenseRowGl(db: SupabaseClient, row: ExpenseGlRow): Promise<void> {
  const amountCents = Math.round(Number(row.amount_cents));
  if (!(amountCents > 0)) return;
  const base = {
    managerUserId: row.manager_user_id,
    amountCents,
    categoryCode: row.category_code,
    propertyId: row.property_id,
    vendorId: row.vendor_id,
    memo: row.memo,
  };
  if (!row.due_date) {
    await postGlExpenseEntry(db, { ...base, expenseId: row.id, entryDate: row.expense_date });
    return;
  }
  await postGlBillApproved(db, { ...base, billId: expenseBillId(row.id), entryDate: row.expense_date });
  if (row.payment_status !== "due") {
    await postGlBillPaid(db, { ...base, billId: expenseBillId(row.id), entryDate: row.paid_date || row.expense_date });
  }
}

/** Remove every journal an expense row owns (cash, accrual, settlement). The row is edited or gone; the books follow it. */
export async function deleteExpenseRowGl(db: SupabaseClient, managerUserId: string, expenseId: string): Promise<void> {
  await deleteGlJournalForSource(db, { managerUserId, sourceType: "expense", sourceId: expenseId });
  await deleteGlJournalForSource(db, { managerUserId, sourceType: "bill", sourceId: `bill-approve:${expenseBillId(expenseId)}` });
  await deleteGlJournalForSource(db, { managerUserId, sourceType: "bill", sourceId: `bill-pay:${expenseBillId(expenseId)}` });
}

/** Re-derive an edited expense row's journals: drop the old ones and post what the row now says. */
export async function rebuildExpenseRowGl(db: SupabaseClient, row: ExpenseGlRow): Promise<void> {
  await deleteExpenseRowGl(db, row.manager_user_id, row.id);
  await postExpenseRowGl(db, row);
}

export type ManualEntryGlRepair = { posted: number; skipped: number; failed: number; dryRun: boolean; wouldPost: number };

const MANUAL_REPAIR_PAGE = 500;

/**
 * Idempotent repair for manual bookkeeping entries that never reached the General Ledger (the write-through
 * was missing before this path existed). Every manual expense (`manager_expense_entries`) and manual income
 * (`ledger_entries` payment with no charge, no Stripe source and no journal link) without a journal gets
 * exactly one balanced journal, keyed by its own id, so a re-run posts nothing. Pages exhaustively, never
 * truncates. Never called from a report route (no read-time backfill): run by script or the admin route.
 */
export async function repairManualEntryGl(
  db: SupabaseClient,
  options: { managerUserId?: string; dryRun?: boolean } = {},
): Promise<ManualEntryGlRepair> {
  const result: ManualEntryGlRepair = { posted: 0, skipped: 0, failed: 0, dryRun: Boolean(options.dryRun), wouldPost: 0 };

  for (let offset = 0; ; offset += MANUAL_REPAIR_PAGE) {
    let q = db
      .from("manager_expense_entries")
      .select("id, manager_user_id, property_id, category_code, amount_cents, expense_date, memo, vendor_id, payment_status, due_date, paid_date")
      // Manual entries only: a paid bill's expense row is settled through its bill journals, a work-order or
      // Stripe-sourced one is posted by its own writer, and posting any of them here would double-book.
      .is("source_work_order_id", null)
      .is("source_stripe_payment_id", null)
      .order("id", { ascending: true })
      .range(offset, offset + MANUAL_REPAIR_PAGE - 1);
    if (options.managerUserId) q = q.eq("manager_user_id", options.managerUserId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ExpenseGlRow[];
    const { data: billLinked, error: billLinkedError } = page.length
      ? await db.from("manager_bills").select("paid_expense_entry_id").in("paid_expense_entry_id", page.map((r) => r.id))
      : { data: [], error: null };
    if (billLinkedError) throw new Error(billLinkedError.message);
    const settledByBill = new Set((billLinked ?? []).map((r) => String((r as { paid_expense_entry_id: string }).paid_expense_entry_id)));
    for (const row of page) {
      if (settledByBill.has(row.id)) { result.skipped++; continue; }
      if (!row.manager_user_id || !(Number(row.amount_cents) > 0) || !row.expense_date) { result.skipped++; continue; }
      const accrual = Boolean(row.due_date);
      const missing = accrual
        ? !(await journalEntryExists(db, row.manager_user_id, "bill", `bill-approve:${expenseBillId(row.id)}`)) ||
          (row.payment_status !== "due" && !(await journalEntryExists(db, row.manager_user_id, "bill", `bill-pay:${expenseBillId(row.id)}`)))
        : !(await journalEntryExists(db, row.manager_user_id, "expense", row.id));
      if (!missing) { result.skipped++; continue; }
      if (options.dryRun) { result.wouldPost++; continue; }
      try {
        await postExpenseRowGl(db, row);
        result.posted++;
      } catch { result.failed++; }
    }
    if (page.length < MANUAL_REPAIR_PAGE) break;
  }

  for (let offset = 0; ; offset += MANUAL_REPAIR_PAGE) {
    let q = db
      .from("ledger_entries")
      .select("id, manager_user_id, property_id, category_code, amount_cents, posted_date, description")
      .eq("entry_type", "payment")
      .is("source_charge_id", null)
      .is("gl_journal_entry_id", null)
      .is("stripe_charge_id", null)
      .is("stripe_checkout_session_id", null)
      .order("id", { ascending: true })
      .range(offset, offset + MANUAL_REPAIR_PAGE - 1);
    if (options.managerUserId) q = q.eq("manager_user_id", options.managerUserId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Array<{ id: string; manager_user_id: string | null; property_id: string | null; category_code: string; amount_cents: number; posted_date: string | null; description: string | null }>;
    for (const row of page) {
      if (!row.manager_user_id || !(Number(row.amount_cents) > 0) || !row.posted_date || !row.category_code) { result.skipped++; continue; }
      const existing = await journalEntryExists(db, row.manager_user_id, "manual", row.id);
      if (existing) {
        // The journal exists but the ledger row never learned its id: link it so this row drops out of the next sweep.
        if (!options.dryRun) await db.from("ledger_entries").update({ gl_journal_entry_id: existing }).eq("id", row.id);
        result.skipped++;
        continue;
      }
      if (options.dryRun) { result.wouldPost++; continue; }
      try {
        await postGlManualIncomeEntry(db, {
          managerUserId: row.manager_user_id, sourceChargeId: row.id, categoryCode: row.category_code,
          amountCents: Number(row.amount_cents), entryDate: row.posted_date, propertyId: row.property_id,
          description: row.description, linkLedgerEntryId: row.id,
        });
        result.posted++;
      } catch { result.failed++; }
    }
    if (page.length < MANUAL_REPAIR_PAGE) break;
  }
  return result;
}

/**
 * Reverse one posted journal (a charge's or a payment's) with a balanced mirror entry: every line swaps its
 * debit and credit, `is_reversal` is true and `reversed_entry_id` names the original. The original is never
 * edited or deleted, so the books keep both. Idempotent: a journal that already has a reversal is left alone,
 * and a source with no journal (nothing was ever posted) returns null.
 */
export async function reverseGlJournalForSource(
  db: SupabaseClient,
  input: { managerUserId: string; sourceType: GlSourceType; sourceId: string; entryDate: string; memo: string },
): Promise<string | null> {
  const originalId = await journalEntryExists(db, input.managerUserId, input.sourceType, input.sourceId);
  if (!originalId) return null;
  const { data: already, error: alreadyError } = await db
    .from("gl_journal_entries")
    .select("id")
    .eq("reversed_entry_id", originalId)
    .eq("is_reversal", true)
    .maybeSingle();
  if (alreadyError) throw new Error(`GL reversal lookup failed: ${alreadyError.message}`);
  if (already?.id) return String(already.id);

  const { data: lines, error: linesReadError } = await db
    .from("gl_journal_lines")
    .select("account_code, debit_cents, credit_cents, property_id, resident_user_id, vendor_id, memo")
    .eq("journal_entry_id", originalId);
  if (linesReadError) throw new Error(`GL reversal lines read failed: ${linesReadError.message}`);
  const original = (lines ?? []) as Array<{
    account_code: string; debit_cents: number; credit_cents: number;
    property_id: string | null; resident_user_id: string | null; vendor_id: string | null; memo: string | null;
  }>;
  if (original.length === 0) return null;
  const mirrored = original.map((line) => ({
    accountCode: line.account_code,
    debitCents: Number(line.credit_cents),
    creditCents: Number(line.debit_cents),
    propertyId: line.property_id,
    residentUserId: line.resident_user_id,
    vendorId: line.vendor_id,
    memo: input.memo,
  }));
  assertBalanced(mirrored);

  const now = new Date().toISOString();
  const { data: entry, error: entryError } = await db
    .from("gl_journal_entries")
    .insert({
      manager_user_id: input.managerUserId,
      property_id: original[0]!.property_id,
      entry_date: input.entryDate,
      memo: input.memo,
      source_type: input.sourceType,
      source_id: input.sourceId,
      is_reversal: true,
      reversed_entry_id: originalId,
      updated_at: now,
    })
    .select("id")
    .single();
  if (entryError || !entry?.id) throw new Error(`GL reversal insert failed: ${entryError?.message ?? "unknown"}`);
  const reversalId = String(entry.id);
  const { error: insertLinesError } = await db.from("gl_journal_lines").insert(
    mirrored.map((line) => ({
      journal_entry_id: reversalId,
      account_code: line.accountCode,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      property_id: line.propertyId,
      resident_user_id: line.residentUserId,
      vendor_id: line.vendorId,
      memo: line.memo,
    })),
  );
  if (insertLinesError) {
    await db.from("gl_journal_entries").delete().eq("id", reversalId);
    throw new Error(`GL reversal lines insert failed: ${insertLinesError.message}`);
  }
  return reversalId;
}
