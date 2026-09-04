"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {Input, Select} from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
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
import { PortalSectionPrimaryButton } from "@/components/portal/portal-list-section";
import { centsToUsd } from "@/lib/reports/money";
import { chartAccountLabel, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";
import type { ManagerBudget } from "@/lib/manager-budgets";

const EXPENSE_CATEGORIES = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "expense");

type BudgetDraft = { categoryCode: string; annual: string };

function emptyDraft(): BudgetDraft {
  return { categoryCode: EXPENSE_CATEGORIES[0]?.code ?? "maintenance", annual: "" };
}

export function ManagerBudgetsPanel() {
  const { showToast } = useAppUi();
  const currentYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [budgets, setBudgets] = useState<ManagerBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<BudgetDraft>(emptyDraft);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/manager-budgets?fiscalYear=${fiscalYear}`);
      const data = (await res.json()) as { budgets?: ManagerBudget[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load budgets.");
      setBudgets(data.budgets ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load budgets.");
    } finally {
      setLoading(false);
    }
  }, [fiscalYear, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBudget() {
    const annualCents = Math.round(Number.parseFloat(draft.annual.replace(/[^0-9.]/g, "")) * 100);
    if (!draft.categoryCode.trim() || !Number.isFinite(annualCents) || annualCents < 0) {
      showToast("Category and annual amount are required.");
      return;
    }
    const res = await fetch("/api/manager-budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryCode: draft.categoryCode, annualCents, fiscalYear }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to save budget.");
      return;
    }
    showToast("Budget saved.");
    setModalOpen(false);
    setDraft(emptyDraft());
    void load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-muted">Fiscal year</label>
          <Input
            type="number"
            className="w-28"
            value={String(fiscalYear)}
            onChange={(e) => setFiscalYear(Number(e.target.value) || currentYear)}
          />
        </div>
        <PortalSectionPrimaryButton onClick={() => setModalOpen(true)} data-attr="finances-add-budget">
          Add budget
        </PortalSectionPrimaryButton>
      </div>
      {loading ? (
        <PortalDataTableEmpty message="Loading budgets…" icon="finance" />
      ) : budgets.length === 0 ? (
        <PortalDataTableEmpty message="No budgets for this fiscal year yet." icon="finance" />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className={PORTAL_DATA_TABLE}>
              <colgroup>
                <col style={{ width: "50%" }} />
                <col style={{ width: "25%" }} />
                <col style={{ width: "25%" }} />
              </colgroup>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={MANAGER_TABLE_TH}>Category</th>
                  <th className={MANAGER_TABLE_TH}>Fiscal year</th>
                  <th className={MANAGER_TABLE_TH}>Annual budget</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((budget) => (
                  <tr key={budget.id} className={PORTAL_TABLE_TR}>
                    <td className={PORTAL_TABLE_TD}>{chartAccountLabel(budget.categoryCode)}</td>
                    <td className={PORTAL_TABLE_TD}>{budget.fiscalYear}</td>
                    <td className={PORTAL_TABLE_TD}>{centsToUsd(budget.annualCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add / update budget"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => createBudget()}>
              Save budget
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted">Category</label>
            <Select
             
              value={draft.categoryCode}
              onChange={(e) => setDraft((d) => ({ ...d, categoryCode: e.target.value }))}
            >
              {EXPENSE_CATEGORIES.map((cat) => (
                <option key={cat.code} value={cat.code}>
                  {cat.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Annual budget (split evenly across 12 months)</label>
            <Input
              className="mt-1"
              value={draft.annual}
              onChange={(e) => setDraft((d) => ({ ...d, annual: e.target.value }))}
              placeholder="12000.00"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
