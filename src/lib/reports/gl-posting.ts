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

type ExpenseMirrorRow = {
  id: string;
  manager_user_id: string;
  property_id: string | null;
  category_code: string;
  amount_cents: number;
  expense_date: string;
  memo: string | null;
  vendor_id: string | null;
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

  let expenseQuery = db
    .from("manager_expense_entries")
    .select("id, manager_user_id, property_id, category_code, amount_cents, expense_date, memo, vendor_id")
    .order("expense_date", { ascending: true })
    .limit(4000);
  if (managerUserId) expenseQuery = expenseQuery.eq("manager_user_id", managerUserId);

  const { data: expenseRows, error: expenseError } = await expenseQuery;
  if (expenseError) throw new Error(expenseError.message);

  for (const row of (expenseRows as ExpenseMirrorRow[] | null) ?? []) {
    if (row.amount_cents <= 0) {
      skipped++;
      continue;
    }
    const exists = await journalEntryExists(db, row.manager_user_id, "expense", row.id);
    if (exists) {
      skipped++;
      continue;
    }
    await postGlExpenseEntry(db, {
      managerUserId: row.manager_user_id,
      expenseId: row.id,
      categoryCode: row.category_code,
      amountCents: Number(row.amount_cents),
      entryDate: row.expense_date,
      propertyId: row.property_id,
      vendorId: row.vendor_id,
      memo: row.memo,
    });
    posted++;
  }

  return { posted, skipped };
}
