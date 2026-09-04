"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {Input, Select} from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { centsToUsd, dollarsToCents } from "@/lib/reports/money";
import {
  BANK_ACCOUNT_TYPES,
  computeReconciliationSummary,
  type BankAccountType,
  type BankStatementLine,
  type ManagerBankAccount,
  type ManagerBankStatement,
} from "@/lib/manager-bank-reconciliation";

type AccountDraft = { name: string; accountType: BankAccountType; lastFour: string };

type StatementDraft = {
  statementDate: string;
  openingBalance: string;
  closingBalance: string;
  lines: { lineDate: string; description: string; amount: string }[];
};

function emptyAccountDraft(): AccountDraft {
  return { name: "", accountType: "operating", lastFour: "" };
}

function emptyStatementDraft(): StatementDraft {
  return {
    statementDate: new Date().toISOString().slice(0, 10),
    openingBalance: "0",
    closingBalance: "0",
    lines: [{ lineDate: new Date().toISOString().slice(0, 10), description: "", amount: "" }],
  };
}

const ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  operating: "Operating",
  trust_rental: "Trust · rental ops",
  trust_security_deposit: "Trust · security deposits",
};

export type ManagerBankReconciliationPanelHandle = {
  openAddAccount: () => void;
  openAddStatement: () => void;
};

export const ManagerBankReconciliationPanel = forwardRef<
  ManagerBankReconciliationPanelHandle,
  { onCanAddStatementChange?: (canAdd: boolean) => void }
>(function ManagerBankReconciliationPanel({ onCanAddStatementChange }, ref) {
  const { showToast } = useAppUi();
  const [accounts, setAccounts] = useState<ManagerBankAccount[]>([]);
  const [statements, setStatements] = useState<ManagerBankStatement[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedStatementId, setSelectedStatementId] = useState("");
  const [loading, setLoading] = useState(true);
  const [accountModal, setAccountModal] = useState(false);
  const [statementModal, setStatementModal] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccountDraft);
  const [statementDraft, setStatementDraft] = useState<StatementDraft>(emptyStatementDraft);

  useImperativeHandle(
    ref,
    () => ({
      openAddAccount: () => setAccountModal(true),
      openAddStatement: () => {
        if (selectedAccountId) setStatementModal(true);
      },
    }),
    [selectedAccountId],
  );

  useEffect(() => {
    onCanAddStatementChange?.(Boolean(selectedAccountId));
  }, [onCanAddStatementChange, selectedAccountId]);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/manager-bank-accounts");
      const data = (await res.json()) as { accounts?: ManagerBankAccount[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load bank accounts.");
      const list = data.accounts ?? [];
      setAccounts(list);
      setSelectedAccountId((cur) => cur || list[0]?.id || "");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load bank accounts.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadStatements = useCallback(async () => {
    if (!selectedAccountId) {
      setStatements([]);
      setSelectedStatementId("");
      return;
    }
    try {
      const res = await fetch(`/api/manager-bank-statements?bankAccountId=${encodeURIComponent(selectedAccountId)}`);
      const data = (await res.json()) as { statements?: ManagerBankStatement[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load statements.");
      const list = data.statements ?? [];
      setStatements(list);
      setSelectedStatementId((cur) => (list.some((s) => s.id === cur) ? cur : list[0]?.id || ""));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load statements.");
    }
  }, [selectedAccountId, showToast]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    void loadStatements();
  }, [loadStatements]);

  const selectedStatement = useMemo(
    () => statements.find((s) => s.id === selectedStatementId) ?? null,
    [statements, selectedStatementId],
  );

  const summary = useMemo(
    () => (selectedStatement ? computeReconciliationSummary(selectedStatement) : null),
    [selectedStatement],
  );

  async function createAccount() {
    if (!accountDraft.name.trim()) {
      showToast("Account name is required.");
      return;
    }
    const res = await fetch("/api/manager-bank-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(accountDraft),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to create account.");
      return;
    }
    showToast("Bank account added.");
    setAccountModal(false);
    setAccountDraft(emptyAccountDraft());
    await loadAccounts();
    if (data.account?.id) setSelectedAccountId(String(data.account.id));
  }

  async function createStatement() {
    if (!selectedAccountId) {
      showToast("Choose a bank account first.");
      return;
    }
    const openingBalanceCents = dollarsToCents(statementDraft.openingBalance);
    const closingBalanceCents = dollarsToCents(statementDraft.closingBalance);
    const lines = statementDraft.lines
      .map((line) => ({
        lineDate: line.lineDate,
        description: line.description.trim(),
        amountCents: dollarsToCents(line.amount),
      }))
      .filter((line) => line.description || line.amountCents !== 0);
    const res = await fetch("/api/manager-bank-statements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankAccountId: selectedAccountId,
        statementDate: statementDraft.statementDate,
        openingBalanceCents,
        closingBalanceCents,
        lines,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to save statement.");
      return;
    }
    showToast("Statement saved.");
    setStatementModal(false);
    setStatementDraft(emptyStatementDraft());
    await loadStatements();
    if (data.statement?.id) setSelectedStatementId(String(data.statement.id));
  }

  async function toggleLineCleared(line: BankStatementLine) {
    const res = await fetch(`/api/manager-bank-statement-lines/${line.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleared: !line.cleared }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to update line.");
      return;
    }
    await loadStatements();
  }

  async function markReconciled() {
    if (!selectedStatement) return;
    const res = await fetch(`/api/manager-bank-statements/${selectedStatement.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciled: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to mark reconciled.");
      return;
    }
    showToast("Statement marked reconciled.");
    await loadStatements();
  }

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-muted">Bank account</label>
          <Select
             
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              data-attr="bank-reconciliation-account"
            >
              <option value="">Select account…</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.lastFour ? ` ···${account.lastFour}` : ""}
                </option>
              ))}
          </Select>
        </div>
        {selectedAccountId ? (
          <div>
            <label className="text-xs font-semibold text-muted">Statement</label>
            <Select
               
                value={selectedStatementId}
                onChange={(e) => setSelectedStatementId(e.target.value)}
                data-attr="bank-reconciliation-statement"
              >
                <option value="">Select statement…</option>
                {statements.map((statement) => (
                  <option key={statement.id} value={statement.id}>
                    {statement.statementDate}
                    {statement.reconciledAt ? " (reconciled)" : ""}
                  </option>
                ))}
            </Select>
          </div>
        ) : null}
      </div>

      {loading ? (
        <PortalDataTableEmpty message="Loading bank accounts…" icon="finance" />
      ) : accounts.length === 0 ? (
        <PortalDataTableEmpty message="No bank accounts yet. Add an operating or trust account to reconcile statements." icon="finance" />
      ) : !selectedStatement ? (
        <PortalDataTableEmpty message="Select or create a statement to reconcile lines." icon="finance" />
      ) : (
        <>
          {summary ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">Reconciliation summary</span>
                <Badge tone={summary.isReconciled ? "success" : summary.differenceCents === 0 ? "success" : "warning"}>
                  {summary.isReconciled
                    ? "Reconciled"
                    : summary.differenceCents === 0
                      ? "Balanced · not marked reconciled"
                      : "Out of balance"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted">
                Opening {centsToUsd(summary.openingBalanceCents)} + cleared {centsToUsd(summary.clearedCents)} ={" "}
                {centsToUsd(summary.reconciledBalanceCents)} · Statement closing {centsToUsd(summary.closingBalanceCents)}
                {summary.differenceCents !== 0 ? ` · Difference ${centsToUsd(summary.differenceCents)}` : ""}
              </p>
              {!selectedStatement.reconciledAt && summary.differenceCents === 0 ? (
                <Button className="mt-2" variant="secondary" onClick={() => markReconciled()} data-attr="bank-mark-reconciled">
                  Mark reconciled
                </Button>
              ) : null}
            </div>
          ) : null}

          {selectedStatement.lines.length === 0 ? (
            <PortalDataTableEmpty message="No statement lines yet." icon="finance" />
          ) : (
            <div className={PORTAL_DATA_TABLE_WRAP}>
              <div className={PORTAL_DATA_TABLE_SCROLL}>
                <table className={PORTAL_DATA_TABLE}>
                  <thead>
                    <tr className={PORTAL_TABLE_HEAD_ROW}>
                      <th className={MANAGER_TABLE_TH}>Date</th>
                      <th className={MANAGER_TABLE_TH}>Description</th>
                      <th className={`${MANAGER_TABLE_TH} text-right`}>Amount</th>
                      <th className={MANAGER_TABLE_TH}>Cleared</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedStatement.lines.map((line) => (
                      <tr key={line.id} className={PORTAL_TABLE_TR}>
                        <td className={PORTAL_TABLE_TD}>{line.lineDate}</td>
                        <td className={PORTAL_TABLE_TD}>{line.description || "—"}</td>
                        <td className={`${PORTAL_TABLE_TD} text-right tabular-nums`}>{centsToUsd(line.amountCents)}</td>
                        <td className={PORTAL_TABLE_TD}>
                          <Button
                            type="button"
                            variant={line.cleared ? "primary" : "outline"}
                            className="h-8 rounded-full px-3 text-xs"
                            onClick={() => toggleLineCleared(line)}
                            data-attr="bank-line-cleared-toggle"
                          >
                            {line.cleared ? "Cleared" : "Outstanding"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        open={accountModal}
        onClose={() => setAccountModal(false)}
        title="Add bank account"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => createAccount()}>
              Save account
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted">Name</label>
            <Input className="mt-1" value={accountDraft.name} onChange={(e) => setAccountDraft((d) => ({ ...d, name: e.target.value }))} />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Type</label>
            <Select
             
              value={accountDraft.accountType}
              onChange={(e) => setAccountDraft((d) => ({ ...d, accountType: e.target.value as BankAccountType }))}
            >
              {BANK_ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACCOUNT_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Last four (optional)</label>
            <Input
              className="mt-1"
              value={accountDraft.lastFour}
              onChange={(e) => setAccountDraft((d) => ({ ...d, lastFour: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) }))}
              placeholder="1234"
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={statementModal}
        onClose={() => setStatementModal(false)}
        title="Add bank statement"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => createStatement()}>
              Save statement
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted">Statement date</label>
            <Input
              type="date"
              className="mt-1"
              value={statementDraft.statementDate}
              onChange={(e) => setStatementDraft((d) => ({ ...d, statementDate: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted">Opening balance</label>
              <Input
                className="mt-1"
                value={statementDraft.openingBalance}
                onChange={(e) => setStatementDraft((d) => ({ ...d, openingBalance: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Closing balance</label>
              <Input
                className="mt-1"
                value={statementDraft.closingBalance}
                onChange={(e) => setStatementDraft((d) => ({ ...d, closingBalance: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">Lines</p>
            {statementDraft.lines.map((line, index) => (
              <div key={index} className="grid grid-cols-1 gap-2 rounded-xl border border-border p-3 sm:grid-cols-3">
                <Input type="date" value={line.lineDate} onChange={(e) => setStatementDraft((d) => {
                  const lines = [...d.lines];
                  lines[index] = { ...lines[index]!, lineDate: e.target.value };
                  return { ...d, lines };
                })} />
                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => setStatementDraft((d) => {
                    const lines = [...d.lines];
                    lines[index] = { ...lines[index]!, description: e.target.value };
                    return { ...d, lines };
                  })}
                />
                <Input
                  placeholder="Amount"
                  value={line.amount}
                  onChange={(e) => setStatementDraft((d) => {
                    const lines = [...d.lines];
                    lines[index] = { ...lines[index]!, amount: e.target.value };
                    return { ...d, lines };
                  })}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => setStatementDraft((d) => ({
                ...d,
                lines: [...d.lines, { lineDate: d.statementDate, description: "", amount: "" }],
              }))}
            >
              Add line
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
});
