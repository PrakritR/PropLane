"use client";

/**
 * Vendor Finances > Overview tab (vendor-portal-ia-1007; a tab of the one Finances page since
 * vendor-finances-1008). The page above it already shows Available / Pending / Held / On the way,
 * so this body adds only what those cards do not: Owed to you, Paid this year, this month's
 * earnings and spend, then "By manager" rows. Every figure comes from
 * `GET /api/vendor/finances/overview` (integer cents computed on the server); this component
 * only formats. When Stripe cannot answer, the figures are the PropLane ledger's and a quiet
 * "Stripe unavailable" fact says so above them, never an error page — unless the page's own
 * balance strip already fell back to the ledger and is saying it (`hideStripeNotice`).
 */
import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalStatStrip, type PortalStat } from "@/components/portal/portal-stat-strip";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalPropertyRecordRow, PortalRowIconTile } from "@/components/portal/portal-record-row";
import type { VendorFinancesOverview } from "@/lib/vendor-banking/overview";

/** Whole dollars like the manager overview ("$7,700"); exact cents live in Statements. */
function wholeMoney(cents: number | null | undefined, currency = "usd"): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(
    Math.round(cents / 100),
  );
}

function monthName(monthKey: string): string {
  const d = new Date(`${monthKey}-15T12:00:00`);
  return Number.isNaN(d.getTime()) ? "This month" : d.toLocaleString("en-US", { month: "long" });
}

export function VendorFinancesOverviewBody({ hideStripeNotice = false }: { hideStripeNotice?: boolean } = {}) {
  const [data, setData] = useState<VendorFinancesOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/finances/overview", { credentials: "include", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as VendorFinancesOverview | null;
      if (!res.ok || !body || !body.balance || !body.month) {
        setState("error");
        return;
      }
      setData(body);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") {
    return <PortalRecordListSurface loading dataAttr="vendor-overview-loading" />;
  }
  if (state === "error" || !data) {
    return (
      <PortalRecordListSurface
        loadError="Could not load your finances."
        onRetry={() => {
          setState("loading");
          void load();
        }}
        dataAttr="vendor-overview-error"
      />
    );
  }

  const cur = data.balance.currency;
  const month = monthName(data.month.monthKey);
  const stat = (id: string, label: string, cents: number | null, tone?: "ok" | "danger"): PortalStat => ({
    id,
    label,
    value: wholeMoney(cents, cur),
    dataAttr: `vendor-overview-${id}`,
    tone: tone === "ok" && (cents ?? 0) > 0 ? "ok" : tone === "danger" && (cents ?? 0) < 0 ? "danger" : undefined,
  });

  return (
    <div className="space-y-4 pb-6" data-attr="vendor-finances-overview">
      {data.stripeUnavailable && !hideStripeNotice ? (
        <p role="status" className="px-1 text-sm text-muted" data-attr="vendor-overview-stripe-unavailable">
          Stripe unavailable
        </p>
      ) : null}
      <PortalStatStrip
        size="lg"
        dataAttr="vendor-overview-month-strip"
        className="[grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]"
        items={[
          stat("owed", "Owed to you", data.balance.owedCents),
          stat("paid-year", "Paid this year", data.balance.paidThisYearCents, "ok"),
          stat("earned", `Earned (${month})`, data.month.earnedCents, "ok"),
          stat("spent", `Spent (${month})`, data.month.spentCents),
          stat("profit", `Profit (${month})`, data.month.profitCents, "ok"),
          { id: "jobs", label: `Jobs (${month})`, value: String(data.month.jobs), dataAttr: "vendor-overview-jobs" },
        ]}
      />
      {data.byManager.length > 0 ? (
        <section className="overflow-hidden rounded-[10px] border border-border bg-card" data-attr="vendor-overview-by-manager">
          <h3 className="border-b border-border px-4 py-2.5 text-[14px] font-semibold text-foreground">By manager</h3>
          <PortalListGroupRowContext.Provider value>
            {data.byManager.map((row) => (
              <PortalPropertyRecordRow
                key={row.managerUserId ?? "unassigned"}
                title={row.label}
                leading={<PortalRowIconTile icon={UserRound} />}
                leadingShape="square"
                facts={
                  <>
                    <span className="font-medium text-[var(--status-confirmed-fg)]">Earned {wholeMoney(row.earnedCents, cur)}</span>
                    <span>Spent {wholeMoney(row.spentCents, cur)}</span>
                  </>
                }
                amount={wholeMoney(row.profitCents, cur)}
                dataAttr="vendor-overview-by-manager-row"
              />
            ))}
          </PortalListGroupRowContext.Provider>
        </section>
      ) : null}
    </div>
  );
}
