/**
 * Bank reconciliation types + pure helpers. Manual statement entry + line
 * matching against `ledger_entries` (Plaid/bank-feed auto-import is out of scope
 * but the schema is feed-ready). Schema:
 * `20260712110000_security_deposit_trust.sql`.
 */
export const BANK_ACCOUNT_TYPES = ["operating", "trust_rental", "trust_security_deposit"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

export type ManagerBankAccount = {
  id: string;
  name: string;
  accountType: BankAccountType;
  glAccountCode: string;
  lastFour: string | null;
  isActive: boolean;
};

export type BankStatementLine = {
  id: string;
  statementId: string;
  lineDate: string;
  description: string;
  amountCents: number;
  matchedLedgerEntryId: string | null;
  matchedExpenseEntryId?: string | null;
  cleared: boolean;
};

export type ManagerBankStatement = {
  id: string;
  bankAccountId: string;
  statementDate: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  reconciledAt: string | null;
  lines: BankStatementLine[];
};

export const BANK_ACCOUNT_SELECT =
  "id, name, account_type, gl_account_code, last_four, is_active";
export const BANK_STATEMENT_SELECT =
  "id, bank_account_id, statement_date, opening_balance_cents, closing_balance_cents, reconciled_at";
export const BANK_STATEMENT_LINE_SELECT =
  "id, statement_id, line_date, description, amount_cents, matched_ledger_entry_id, matched_expense_entry_id, cleared";

export type ReconciliationSummary = {
  openingBalanceCents: number;
  closingBalanceCents: number;
  clearedCents: number;
  reconciledBalanceCents: number;
  differenceCents: number;
  isReconciled: boolean;
  lineCount: number;
  clearedCount: number;
};

/**
 * Reconciliation check: opening balance + sum(cleared line amounts) should equal
 * the statement's closing balance. A zero difference means the statement ties out.
 */
export function computeReconciliationSummary(
  statement: Pick<ManagerBankStatement, "openingBalanceCents" | "closingBalanceCents" | "lines">,
): ReconciliationSummary {
  const cleared = statement.lines.filter((l) => l.cleared);
  const clearedCents = cleared.reduce((sum, l) => sum + l.amountCents, 0);
  const reconciledBalanceCents = statement.openingBalanceCents + clearedCents;
  const differenceCents = statement.closingBalanceCents - reconciledBalanceCents;
  return {
    openingBalanceCents: statement.openingBalanceCents,
    closingBalanceCents: statement.closingBalanceCents,
    clearedCents,
    reconciledBalanceCents,
    differenceCents,
    isReconciled: differenceCents === 0,
    lineCount: statement.lines.length,
    clearedCount: cleared.length,
  };
}

export function mapBankAccountRow(row: Record<string, unknown>): ManagerBankAccount {
  return {
    id: String(row.id),
    name: String(row.name),
    accountType: row.account_type as BankAccountType,
    glAccountCode: String(row.gl_account_code),
    lastFour: row.last_four ? String(row.last_four) : null,
    isActive: Boolean(row.is_active),
  };
}

export function mapBankStatementLineRow(row: Record<string, unknown>): BankStatementLine {
  return {
    id: String(row.id),
    statementId: String(row.statement_id),
    lineDate: String(row.line_date).slice(0, 10),
    description: String(row.description ?? ""),
    amountCents: Number(row.amount_cents),
    matchedLedgerEntryId: row.matched_ledger_entry_id ? String(row.matched_ledger_entry_id) : null,
    matchedExpenseEntryId: row.matched_expense_entry_id ? String(row.matched_expense_entry_id) : null,
    cleared: Boolean(row.cleared),
  };
}

export function mapBankStatementRow(
  row: Record<string, unknown>,
  lines: BankStatementLine[] = [],
): ManagerBankStatement {
  return {
    id: String(row.id),
    bankAccountId: String(row.bank_account_id),
    statementDate: String(row.statement_date).slice(0, 10),
    openingBalanceCents: Number(row.opening_balance_cents ?? 0),
    closingBalanceCents: Number(row.closing_balance_cents ?? 0),
    reconciledAt: row.reconciled_at ? String(row.reconciled_at) : null,
    lines,
  };
}
