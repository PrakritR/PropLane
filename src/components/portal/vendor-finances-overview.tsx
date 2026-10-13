"use client";

/**
 * Vendor Finances > Overview tab (vendor-portal-ia-1007; a tab of the one Finances page since
 * vendor-finances-1008). The page above it already shows Available / Pending / Held / On the way,
 * so this body adds only what those cards do not, as plain rows in the same money format (no second
 * tile row): Owed to you, Paid this year, this month's earnings and spend, then "By manager" rows. Every figure comes from
 * `GET /api/vendor/finances/overview` (integer cents computed on the server); this component
 * only formats. When Stripe cannot answer, the figures are the PropLane ledger's and a quiet
 * "Stripe unavailable" fact says so above them, never an error page — unless the page's own
 * balance strip already fell back to the ledger and is saying it (`hideStripeNotice`).
 */
import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { formatMoney } from "@/components/portal/portal-payouts-panel";
import { vendorOverviewRows } from "@/lib/vendor-banking/overview-display";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalPropertyRecordRow, PortalRowIconTile } from "@/components/portal/portal-record-row";
import type { VendorFinancesOverview } from "@/lib/vendor-banking/overview";

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
  const rows = vendorOverviewRows(data, formatMoney);

  return (
    <div className="space-y-4 pb-6" data-attr="vendor-finances-overview">
      {data.stripeUnavailable && !hideStripeNotice ? (
        <p role="status" className="px-1 text-sm text-muted" data-attr="vendor-overview-stripe-unavailable">
          Stripe unavailable
        </p>
      ) : null}
      <section className="overflow-hidden rounded-[10px] border border-border bg-card" data-attr="vendor-overview-month-rows">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0">
            <span className="min-w-0 truncate text-[14px] text-foreground">{row.label}</span>
            <strong
              className={`shrink-0 text-[15px] font-semibold tabular-nums ${row.tone === "ok" ? "text-[var(--status-confirmed-fg)]" : "text-foreground"}`}
              data-attr={`vendor-overview-${row.id}`}
            >
              {row.value}
            </strong>
          </div>
        ))}
      </section>
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
                    <span className="font-medium text-[var(--status-confirmed-fg)]">Earned {formatMoney(row.earnedCents, cur)}</span>
                    <span>Spent {formatMoney(row.spentCents, cur)}</span>
                  </>
                }
                amount={formatMoney(row.profitCents, cur)}
                dataAttr="vendor-overview-by-manager-row"
              />
            ))}
          </PortalListGroupRowContext.Provider>
        </section>
      ) : null}
    </div>
  );
}
