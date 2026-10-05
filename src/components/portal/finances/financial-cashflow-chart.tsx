"use client";
import { loadFinancialActivity, invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { useEffect, useState } from "react";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { HOUSEHOLD_CHARGES_EVENT } from "@/lib/household-charges";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import type { summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
import { lastNMonths, type MonthlyCashflowPoint } from "@/lib/portal-monthly-profit";

/** The dashboard and Finances chart read the same server-classified cash events. */
export function FinancialCashflowChart({ userId }: { userId: string | null }) {
  const [points, setPoints] = useState<MonthlyCashflowPoint[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    async function load(event?: Event) {
      if (event && !invalidateFinancialActivity(event)) return;
      const request = ++sequence;
      // The chart owns the period, the series toggles, the table and the hover, so blanking the
      // points here unmounted it and threw all of that away every time a charge or an outgoing
      // payment fired. The previous months stay on screen until the new ones arrive.
      setError("");
      try {
        const data = await loadFinancialActivity(userId);
        const summary = JSON.parse(String(data.meta?.summary)) as ReturnType<typeof summarizeFinancialActivity>;
        if (!disposed && request === sequence) setPoints(lastNMonths(Date.now(), 24).map(month => {
          const totals = summary.months[month.key];
          return { ...month, revenue: (totals?.revenueCents ?? 0) / 100, expense: (totals?.expenseCents ?? 0) / 100, profit: (totals?.profitCents ?? 0) / 100 };
        }));
      } catch (err) { if (!disposed && request === sequence) setError(err instanceof Error ? err.message : "Could not load cash flow."); }
    }
    void load();
    const events = [WORKSPACE_SELECTION_EVENT, HOUSEHOLD_CHARGES_EVENT, MANAGER_OUTGOING_PAYMENTS_EVENT];
    events.forEach(event => window.addEventListener(event, load));
    return () => { disposed = true; events.forEach(event => window.removeEventListener(event, load)); };
  }, [userId]);
  return error ? <p role="alert">{error}</p> : points ? <MonthlyProfitChart points={points} /> : <p role="status">Loading cash flow…</p>;
}
