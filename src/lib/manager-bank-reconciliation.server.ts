import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BANK_ACCOUNT_SELECT,
  BANK_STATEMENT_LINE_SELECT,
  BANK_STATEMENT_SELECT,
  BANK_ACCOUNT_TYPES,
  mapBankAccountRow,
  mapBankStatementLineRow,
  mapBankStatementRow,
  type BankAccountType,
  type BankStatementLine,
  type ManagerBankAccount,
  type ManagerBankStatement,
} from "@/lib/manager-bank-reconciliation";

export async function listBankAccounts(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerBankAccount[]> {
  const { data, error } = await db
    .from("manager_bank_accounts")
    .select(BANK_ACCOUNT_SELECT)
    .eq("manager_user_id", managerUserId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapBankAccountRow(row as Record<string, unknown>));
}

export type CreateBankAccountInput = {
  managerUserId: string;
  name: string;
  accountType: BankAccountType;
  glAccountCode?: string;
  lastFour?: string | null;
};

const DEFAULT_GL_ACCOUNT: Record<BankAccountType, string> = {
  operating: "operating_cash",
  trust_rental: "trust_account_rental_ops",
  trust_security_deposit: "trust_account_security_deposits",
};

export async function createBankAccount(
  db: SupabaseClient,
  input: CreateBankAccountInput,
): Promise<ManagerBankAccount> {
  const name = input.name.trim();
  if (!name) throw new Error("A bank account name is required.");
  if (!BANK_ACCOUNT_TYPES.includes(input.accountType)) throw new Error("Invalid account type.");

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_bank_accounts")
    .insert({
      manager_user_id: input.managerUserId,
      name,
      account_type: input.accountType,
      gl_account_code: input.glAccountCode?.trim() || DEFAULT_GL_ACCOUNT[input.accountType],
      last_four: input.lastFour?.replace(/[^0-9]/g, "").slice(-4) || null,
      is_active: true,
      updated_at: now,
    })
    .select(BANK_ACCOUNT_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Bank account create failed.");
  return mapBankAccountRow(data as Record<string, unknown>);
}

async function loadStatementLines(
  db: SupabaseClient,
  statementIds: string[],
): Promise<Map<string, BankStatementLine[]>> {
  const byStatement = new Map<string, BankStatementLine[]>();
  if (statementIds.length === 0) return byStatement;
  const { data, error } = await db
    .from("manager_bank_statement_lines")
    .select(BANK_STATEMENT_LINE_SELECT)
    .in("statement_id", statementIds)
    .order("line_date", { ascending: true });
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    const line = mapBankStatementLineRow(row as Record<string, unknown>);
    const list = byStatement.get(line.statementId) ?? [];
    list.push(line);
    byStatement.set(line.statementId, list);
  }
  return byStatement;
}

export async function listBankStatements(
  db: SupabaseClient,
  managerUserId: string,
  bankAccountId?: string,
): Promise<ManagerBankStatement[]> {
  let query = db
    .from("manager_bank_statements")
    .select(BANK_STATEMENT_SELECT)
    .eq("manager_user_id", managerUserId)
    .order("statement_date", { ascending: false })
    .limit(60);
  if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const statements = (data ?? []).map((row) => row as Record<string, unknown>);
  const lines = await loadStatementLines(
    db,
    statements.map((s) => String(s.id)),
  );
  return statements.map((row) => mapBankStatementRow(row, lines.get(String(row.id)) ?? []));
}

export type CreateBankStatementInput = {
  sourceFileName?: string;
  sourceFileSha256?: string;
  managerUserId: string;
  bankAccountId: string;
  statementDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  lines?: { lineDate: string; description: string; amountCents: number }[];
};

export async function createBankStatement(
  db: SupabaseClient,
  input: CreateBankStatementInput,
): Promise<ManagerBankStatement> {
  const { data: account, error: accountError } = await db
    .from("manager_bank_accounts")
    .select("id")
    .eq("id", input.bankAccountId)
    .eq("manager_user_id", input.managerUserId)
    .maybeSingle();
  if (accountError) throw new Error(accountError.message);
  if (!account) throw new Error("Bank account not found.");

  if (input.sourceFileSha256) {
    const { data: id, error } = await db.rpc("import_bank_statement_file", { p_owner: input.managerUserId, p_account: input.bankAccountId, p_date: input.statementDate, p_opening: input.openingBalanceCents, p_closing: input.closingBalanceCents, p_lines: input.lines ?? [], p_sha: input.sourceFileSha256, p_name: input.sourceFileName ?? "statement.csv" });
    if (error || !id) throw new Error(error?.message ?? "Statement import failed");
    const { data: statement, error: readError } = await db.from("manager_bank_statements").select(BANK_STATEMENT_SELECT).eq("id", id).eq("manager_user_id", input.managerUserId).single();
    if (readError || !statement) throw new Error(readError?.message ?? "Imported statement could not be read");
    const lines = await loadStatementLines(db, [String(id)]);
    return mapBankStatementRow(statement, lines.get(String(id)) ?? []);
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_bank_statements")
    .insert({
      manager_user_id: input.managerUserId,
      bank_account_id: input.bankAccountId,
      statement_date: input.statementDate.slice(0, 10),
      opening_balance_cents: Math.round(input.openingBalanceCents ?? 0),
      closing_balance_cents: Math.round(input.closingBalanceCents ?? 0),
      updated_at: now,
    })
    .select(BANK_STATEMENT_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Statement create failed.");
  const statementId = String((data as Record<string, unknown>).id);

  const lineInputs = input.lines ?? [];
  if (lineInputs.length > 0) {
    const rows = lineInputs.map((l) => ({
      statement_id: statementId,
      line_date: l.lineDate.slice(0, 10),
      description: l.description?.trim() ?? "",
      amount_cents: Math.round(l.amountCents),
      cleared: false,
    }));
    const { error: linesError } = await db.from("manager_bank_statement_lines").insert(rows);
    if (linesError) throw new Error(linesError.message);
  }

  const [statement] = await listBankStatements(db, input.managerUserId, input.bankAccountId);
  return statement ?? mapBankStatementRow(data as Record<string, unknown>, []);
}

/**
 * Verify the line belongs to a statement the manager owns, then set its match /
 * cleared state. Ownership is enforced by joining through the statement — a line
 * id from another manager's statement resolves to no owned statement and throws.
 */
export async function reconcileBankStatementLine(
  db: SupabaseClient,
  managerUserId: string,
  lineId: string,
  patch: { matchedLedgerEntryId?: string | null; matchedExpenseEntryId?: string | null; cleared?: boolean },
): Promise<BankStatementLine> {
  const { data: line, error: lineError } = await db
    .from("manager_bank_statement_lines")
    .select("id, statement_id")
    .eq("id", lineId)
    .maybeSingle();
  if (lineError) throw new Error(lineError.message);
  if (!line) throw new Error("Statement line not found.");

  const { data: statement, error: statementError } = await db
    .from("manager_bank_statements")
    .select("id")
    .eq("id", String(line.statement_id))
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (statementError) throw new Error(statementError.message);
  if (!statement) throw new Error("Statement line not found.");

  if (patch.matchedLedgerEntryId && patch.matchedExpenseEntryId) throw new Error("Select one transaction to match.");
  const update: Record<string, unknown> = {};
  if (patch.matchedLedgerEntryId !== undefined) {
    update.matched_ledger_entry_id = patch.matchedLedgerEntryId || null;
    if (patch.matchedLedgerEntryId) update.matched_expense_entry_id = null;
  }
  if (patch.matchedExpenseEntryId !== undefined) {
    update.matched_expense_entry_id = patch.matchedExpenseEntryId || null;
    if (patch.matchedExpenseEntryId) update.matched_ledger_entry_id = null;
  }
  if (patch.cleared !== undefined) update.cleared = patch.cleared;
  if (Object.keys(update).length === 0) throw new Error("Nothing to reconcile.");

  const { data, error } = await db
    .from("manager_bank_statement_lines")
    .update(update)
    .eq("id", lineId)
    .select(BANK_STATEMENT_LINE_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Reconcile failed.");
  return mapBankStatementLineRow(data as Record<string, unknown>);
}

export async function setStatementReconciled(
  db: SupabaseClient,
  managerUserId: string,
  statementId: string,
  reconciled: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_bank_statements")
    .update({
      reconciled_at: reconciled ? now : null,
      reconciled_by: reconciled ? managerUserId : null,
      updated_at: now,
    })
    .eq("id", statementId)
    .eq("manager_user_id", managerUserId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Statement not found.");
}
