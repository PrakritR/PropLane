"use client";

/**
 * Vendor Finances > Overview (vendor-portal-ia-1007), copying the manager Finances overview's
 * shape: a balance strip, this month's strip, then "By manager" rows. Every figure comes from
 * `GET /api/vendor/finances/overview` (integer cents computed on the server); this component
 * only formats. When Stripe cannot answer the strip shows the PropLane ledger's numbers with a
 * quiet "Stripe unavailable" fact, never an error page.
 */
import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalStatStrip, type PortalStat } from "@/components/portal/portal-stat-strip";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalPropertyRecordRow, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { VendorWithdrawAction, useVendorBalance } from "@/components/portal/vendor-finances-balance";
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

export function VendorFinancesOverview({ basePath: _basePath = "/vendor" }: { basePath?: string }) {
  void _basePath;
  const [data, setData] = useState<VendorFinancesOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const withdrawState = useVendorBalance();

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
    return (
      <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
        <PortalRecordListSurface loading dataAttr="vendor-overview-loading" />
      </ManagerPortalPageShell>
    );
  }
  if (state === "error" || !data) {
    return (
      <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
        <PortalRecordListSurface
          loadError="Could not load your finances."
          onRetry={() => {
            setState("loading");
            void load();
          }}
          dataAttr="vendor-overview-error"
        />
      </ManagerPortalPageShell>
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
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
      <div className="space-y-4 pb-6" data-attr="vendor-finances-overview">
        <div className="flex items-start gap-3">
          <PortalStatStrip
            size="lg"
            className="min-w-0 flex-1"
            dataAttr="vendor-overview-balance-strip"
            items={[
              stat("available", "Available", data.balance.availableCents),
              stat("pending", "Pending payout", data.balance.pendingCents),
              stat("owed", "Owed to you", data.balance.owedCents),
              stat("paid-year", "Paid this year", data.balance.paidThisYearCents, "ok"),
            ]}
          />
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            <VendorWithdrawAction state={withdrawState.state} reload={withdrawState.reload} />
          </div>
        </div>
        {data.stripeUnavailable ? (
          <p role="status" className="text-sm text-muted" data-attr="vendor-overview-stripe-unavailable">
            Stripe unavailable
          </p>
        ) : null}
        <PortalStatStrip
          size="lg"
          dataAttr="vendor-overview-month-strip"
          className="[grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]"
          items={[
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
    </ManagerPortalPageShell>
  );
}
