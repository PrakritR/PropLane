import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { dollarsToCents } from "@/lib/reports/money";
import { parseMoneyAmount } from "@/lib/parse-money";
import { postGlReclassifyDeposit } from "@/lib/reports/gl-posting";

export type SecurityDepositStatus =
  | "held"
  | "partially_refunded"
  | "refunded"
  | "forfeited"
  | "applied_to_damages";

export type SecurityDepositDispositionType = "full_refund" | "itemized_partial" | "full_withhold";

export type SecurityDepositItemizationLine = {
  label: string;
  amountCents: number;
  kind?: "deduction" | "refund";
  date?: string;
  sourceId?: string;
  journalId?: string;
  evidence?: { inspectionId: string; baselineId: string | null; itemId: string; billId: string };
};

export type SecurityDepositLedgerRow = {
  id: string;
  managerUserId: string;
  sourceChargeId: string;
  propertyId: string | null;
  unitLabel: string | null;
  leaseId: string | null;
  residentUserId: string | null;
  residentEmail: string;
  amountCents: number;
  amountHeldCents: number;
  receivedDate: string;
  status: SecurityDepositStatus;
  dispositionType: SecurityDepositDispositionType | null;
  dispositionDate: string | null;
  dispositionJournalId?: string | null;
  itemization: SecurityDepositItemizationLine[];
};

export type DispositionSplit = {
  refundCents: number;
  withholdCents: number;
  dispositionType: SecurityDepositDispositionType;
};

/**
 * Compute a deposit disposition split from the amount held and the damages to
 * withhold. The refund is always the remainder — the caller (tool/UI) supplies
 * only the withheld/damages figure, never the refund, so the two can never
 * disagree or exceed the held balance.
 */
export function computeDispositionSplit(amountHeldCents: number, withholdCents: number): DispositionSplit {
  const held = Math.max(0, Math.round(amountHeldCents));
  const withhold = Math.min(held, Math.max(0, Math.round(withholdCents)));
  const refund = held - withhold;
  const dispositionType: SecurityDepositDispositionType =
    withhold === 0 ? "full_refund" : refund === 0 ? "full_withhold" : "itemized_partial";
  return { refundCents: refund, withholdCents: withhold, dispositionType };
}

export type DisposeSecurityDepositInput = {
  managerUserId: string;
  depositId: string;
  dispositionType: SecurityDepositDispositionType;
  refundCents: number;
  withholdCents: number;
  itemization?: SecurityDepositItemizationLine[];
  dispositionDate?: string;
  memo?: string;
};

const LIABILITY_ACCOUNT = "security_deposit_liability";
const TRUST_CASH_ACCOUNT = "trust_account_security_deposits";
const DAMAGES_INCOME_ACCOUNT = "other_income";

function mapDepositRow(row: Record<string, unknown>): SecurityDepositLedgerRow {
  const itemization = Array.isArray(row.itemization)
    ? (row.itemization as SecurityDepositItemizationLine[])
    : [];
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id),
    sourceChargeId: String(row.source_charge_id),
    propertyId: row.property_id ? String(row.property_id) : null,
    unitLabel: row.unit_label ? String(row.unit_label) : null,
    leaseId: row.lease_id ? String(row.lease_id) : null,
    residentUserId: row.resident_user_id ? String(row.resident_user_id) : null,
    residentEmail: String(row.resident_email),
    amountCents: Number(row.amount_cents),
    amountHeldCents: Number(row.amount_held_cents),
    receivedDate: String(row.received_date).slice(0, 10),
    status: row.status as SecurityDepositStatus,
    dispositionType: row.disposition_type
      ? (row.disposition_type as SecurityDepositDispositionType)
      : null,
    dispositionDate: row.disposition_date ? String(row.disposition_date).slice(0, 10) : null,
    dispositionJournalId: row.disposition_journal_entry_id ? String(row.disposition_journal_entry_id) : null,
    itemization,
  };
}

/**
 * Record a received security deposit in the sub-ledger when payment syncs.
 * GL receipt is already handled by charge+payment posting (DR trust cash / CR liability).
 */
export async function receiveSecurityDeposit(
  db: SupabaseClient,
  charge: HouseholdCharge,
  opts?: { receivedDate?: string; receiptJournalEntryId?: string | null },
): Promise<string | null> {
  if (charge.kind !== "security_deposit" || charge.status !== "paid") return null;
  if (!charge.managerUserId) return null;

  const amountCents = dollarsToCents(parseMoneyAmount(charge.amountLabel));
  if (amountCents <= 0) return null;

  const receivedDate =
    opts?.receivedDate?.slice(0, 10) ??
    charge.paidAt?.slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  const { data: existing } = await db
    .from("security_deposit_ledger")
    .select("id")
    .eq("manager_user_id", charge.managerUserId)
    .eq("source_charge_id", charge.id)
    .maybeSingle();

  if (existing?.id) return String(existing.id);

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("security_deposit_ledger")
    .insert({
      manager_user_id: charge.managerUserId,
      source_charge_id: charge.id,
      property_id: charge.propertyId || null,
      unit_label: charge.propertyLabel || null,
      lease_id: charge.applicationId ?? null,
      resident_user_id: charge.residentUserId,
      resident_email: charge.residentEmail.trim().toLowerCase(),
      amount_cents: amountCents,
      amount_held_cents: amountCents,
      received_date: receivedDate,
      status: "held",
      receipt_journal_entry_id: opts?.receiptJournalEntryId ?? null,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw new Error(`Security deposit ledger insert failed: ${error?.message ?? "unknown"}`);
  }

  return String(data.id);
}

/** Reviewed historical transactions preserve their own dates and replay-safe GL source IDs. */
export async function importSecurityDepositHistory(db: SupabaseClient, managerUserId: string, depositId: string, originalCents: number, lines: Array<SecurityDepositItemizationLine & { kind: "deduction" | "refund"; date: string; sourceId: string }>) {
  const refund = lines.filter(l => l.kind === "refund").reduce((sum, l) => sum + l.amountCents, 0);
  const withheld = lines.filter(l => l.kind === "deduction").reduce((sum, l) => sum + l.amountCents, 0);
  const { data, error } = await db.rpc("commit_security_deposit_disposition", { p_owner: managerUserId, p_deposit: depositId, p_expected_held: originalCents, p_refund: refund, p_withhold: withheld, p_type: withheld ? "itemized_partial" : "full_refund", p_date: lines.map(l => l.date).sort().at(-1), p_itemization: lines, p_memo: "Reviewed historical deposit transactions", p_history: lines });
  if (error || !data) throw new Error(error?.message ?? "Deposit history commit failed");
  return mapDepositRow(data as Record<string, unknown>);
}

export async function listSecurityDeposits(
  db: SupabaseClient,
  managerUserId: string,
  filters?: { propertyId?: string; status?: SecurityDepositStatus },
): Promise<SecurityDepositLedgerRow[]> {
  let query = db
    .from("security_deposit_ledger")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .order("received_date", { ascending: false })
    .limit(500);

  if (filters?.propertyId) query = query.eq("property_id", filters.propertyId);
  if (filters?.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapDepositRow(row as Record<string, unknown>));
}

export async function getSecurityDepositById(
  db: SupabaseClient,
  managerUserId: string,
  depositId: string,
): Promise<SecurityDepositLedgerRow | null> {
  const { data, error } = await db
    .from("security_deposit_ledger")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .eq("id", depositId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapDepositRow(data as Record<string, unknown>) : null;
}

export async function getSecurityDepositByChargeId(
  db: SupabaseClient,
  managerUserId: string,
  sourceChargeId: string,
): Promise<SecurityDepositLedgerRow | null> {
  const { data, error } = await db
    .from("security_deposit_ledger")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .eq("source_charge_id", sourceChargeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapDepositRow(data as Record<string, unknown>) : null;
}

/**
 * Move-out disposition: refund portion to resident, withhold damages to income.
 */
export async function disposeSecurityDeposit(
  db: SupabaseClient,
  input: DisposeSecurityDepositInput,
): Promise<SecurityDepositLedgerRow> {
  const deposit = await getSecurityDepositById(db, input.managerUserId, input.depositId);
  if (!deposit) throw new Error("Security deposit not found.");
  if (deposit.status !== "held" && deposit.status !== "partially_refunded") {
    throw new Error("Deposit already disposed.");
  }

  const refundCents = Math.max(0, Math.round(input.refundCents));
  const withholdCents = Math.max(0, Math.round(input.withholdCents));
  const total = refundCents + withholdCents;
  if (total <= 0 || total > deposit.amountHeldCents) {
    throw new Error("Disposition amounts must be positive and not exceed amount held.");
  }

  const { data, error } = await db.rpc("commit_security_deposit_disposition", {
    p_owner: input.managerUserId, p_deposit: input.depositId, p_expected_held: deposit.amountHeldCents,
    p_refund: refundCents, p_withhold: withholdCents, p_type: input.dispositionType,
    p_date: input.dispositionDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    p_itemization: input.itemization ?? [], p_memo: input.memo ?? "Security deposit disposition", p_history: null,
  });
  if (error || !data) throw new Error(error?.message ?? "Deposit disposition commit failed");
  return mapDepositRow(data as Record<string, unknown>);
}

export type ReclassifyDepositsResult = {
  dryRun: boolean;
  rowCount: number;
  totalCents: number;
  chargeIds: string[];
  applied?: number;
};

const MISCLASSIFIED_DEPOSIT_CATEGORY = "other_income";
const CORRECT_DEPOSIT_CATEGORY = "security_deposit_liability";

/** Find historical security-deposit payments booked to other_income. */
export async function reclassifyMisclassifiedDeposits(
  db: SupabaseClient,
  managerUserId: string,
  opts: { dryRun: boolean },
): Promise<ReclassifyDepositsResult> {
  const { data: charges } = await db
    .from("portal_household_charge_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .limit(2000);

  const depositChargeIds = new Set<string>();
  for (const row of charges ?? []) {
    const charge = row.row_data as HouseholdCharge | null;
    if (charge?.kind === "security_deposit" && charge.status === "paid") {
      depositChargeIds.add(charge.id);
    }
  }

  if (depositChargeIds.size === 0) {
    return { dryRun: opts.dryRun, rowCount: 0, totalCents: 0, chargeIds: [] };
  }

  const { data: ledgerRows, error } = await db
    .from("ledger_entries")
    .select("id, source_charge_id, category_code, amount_cents, posted_date, manager_user_id, property_id, resident_user_id, resident_email, unit_label, lease_id")
    .eq("manager_user_id", managerUserId)
    .eq("category_code", MISCLASSIFIED_DEPOSIT_CATEGORY)
    .in("source_charge_id", [...depositChargeIds]);

  if (error) throw new Error(error.message);

  const rows = ledgerRows ?? [];
  const chargeIds = [...new Set(rows.map((r) => String(r.source_charge_id)).filter(Boolean))];
  const totalCents = rows.reduce((sum, r) => sum + Number(r.amount_cents), 0);

  if (opts.dryRun || rows.length === 0) {
    return { dryRun: opts.dryRun, rowCount: rows.length, totalCents, chargeIds };
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let applied = 0;

  for (const row of rows) {
    const chargeId = String(row.source_charge_id);
    await db
      .from("ledger_entries")
      .update({ category_code: CORRECT_DEPOSIT_CATEGORY, updated_at: now })
      .eq("id", row.id);

    const { data: chargeRow } = await db
      .from("portal_household_charge_records")
      .select("row_data")
      .eq("id", chargeId)
      .maybeSingle();
    const charge = chargeRow?.row_data as HouseholdCharge | undefined;
    if (charge) {
      await receiveSecurityDeposit(db, charge, { receivedDate: String(row.posted_date).slice(0, 10) });
    }

    await postGlReclassifyDeposit(db, {
      managerUserId,
      sourceId: `reclassify:${row.id}:${today}`,
      entryDate: today,
      amountCents: Number(row.amount_cents),
      propertyId: row.property_id ? String(row.property_id) : null,
      residentUserId: row.resident_user_id ? String(row.resident_user_id) : null,
      memo: `Reclassify deposit from ${MISCLASSIFIED_DEPOSIT_CATEGORY}`,
    });

    applied++;
  }

  await db.from("manager_reclassification_log").insert({
    manager_user_id: managerUserId,
    action_type: "security_deposit_reclassify",
    row_count: rows.length,
    total_cents: totalCents,
    details: { chargeIds, appliedAt: now },
  });

  return { dryRun: false, rowCount: rows.length, totalCents, chargeIds, applied };
}

export async function sumHeldDepositsCents(
  db: SupabaseClient,
  managerUserId: string,
  propertyId?: string,
): Promise<number> {
  let query = db
    .from("security_deposit_ledger")
    .select("amount_held_cents")
    .eq("manager_user_id", managerUserId)
    .gt("amount_held_cents", 0);

  if (propertyId) query = query.eq("property_id", propertyId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, row) => sum + Number(row.amount_held_cents), 0);
}

export { LIABILITY_ACCOUNT, TRUST_CASH_ACCOUNT, DAMAGES_INCOME_ACCOUNT };
