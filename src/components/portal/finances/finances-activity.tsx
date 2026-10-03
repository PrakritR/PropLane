"use client";
import { loadFinancialActivity, invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { useEffect, useState } from "react";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { HOUSEHOLD_CHARGES_EVENT } from "@/lib/household-charges";
import { useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import type { ReportResult } from "@/lib/reports/types";
import { Receipt } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";

export function ManagerFinancesActivity({ direction, userId }: { direction?: "in" | "out"; userId?: string | null }) {
  const params = useSearchParams();
  const [report, setReport] = useState<ReportResult | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => { if (!invalidateFinancialActivity(event)) return; setReport(null); setError(""); setRevision(n => n + 1); };
    const events = [WORKSPACE_SELECTION_EVENT, MANAGER_OUTGOING_PAYMENTS_EVENT, HOUSEHOLD_CHARGES_EVENT];
    events.forEach(name => window.addEventListener(name, refresh));
    return () => events.forEach(name => window.removeEventListener(name, refresh));
  }, []);
  const [search, setSearch] = useState("");
  const [clearedFilter, setClearedFilter] = useState<string | null>(null);
  const filterKey = `${direction || ""}:${params.toString()}`;
  const clear = clearedFilter === filterKey;
  const dir = clear ? "" : direction || params.get("direction") || "";
  const month = clear ? "" : params.get("month") || "";
  const category = clear ? "" : params.get("category") || "";
  useEffect(() => {
    let cancelled = false;
    loadFinancialActivity(userId).then(data => {
      if (!cancelled) setReport(data);
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [revision, userId]);
  const rows = (report?.rows ?? []).filter(row => {
    const amount = Number(row.amountCents);
    return (!dir || (dir === "in" ? amount > 0 : amount < 0)) && (!month || String(row.date).startsWith(month)) &&
      (!category || (category === "deposits" ? /deposit/.test(String(row.categoryCode)) : row.categoryCode === category)) &&
      (!search || [row.who, row.description, row.property, row.category, row.amount].join(" ").toLowerCase().includes(search.toLowerCase()));
  });
  return <div data-attr="finances-activity">
    <Input aria-label="Search activity" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} />
    {dir || month || category ? <div className="py-3 text-sm">Showing: {[dir && (dir === "in" ? "In" : "Out"), /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : month, category].filter(Boolean).join(" · ")} · <button type="button" className="text-primary" onClick={() => setClearedFilter(filterKey)}>Clear</button></div> : null}
    {error ? <p role="alert" className="py-6">{error}</p> : !report ? <p role="status" className="py-6">Loading activity…</p> : (
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        empty={<p className="py-6 text-muted">No entries found.</p>}
        dataAttr="finances-activity-list"
      >
        {rows.map((row) => {
          const cents = Number(row.amountCents);
          const date = ledgerDateTile(String(row.date));
          const balance = typeof row.runningBalanceCents === "number" ? `${USD.format(row.runningBalanceCents / 100)} balance` : undefined;
          return (
            <PortalPropertyRecordRow
              key={String(row.id)}
              title={String(row.who || row.description)}
              address={[row.description, row.property].filter(Boolean).join(" · ") || undefined}
              leading={
                <span className="grid h-12 w-14 place-items-center rounded-[10px] bg-primary/10 text-center leading-none text-primary" data-attr="finances-activity-date">
                  <span className="text-[10px] font-bold uppercase tracking-wide">{date.month}</span>
                  <span className="-mt-1 text-[17px] font-extrabold tabular-nums">{date.day}</span>
                </span>
              }
              facts={<PortalRowFact icon={Receipt}>{[row.category, row.source].filter(Boolean).join(" · ")}</PortalRowFact>}
              amount={`${cents > 0 ? "+" : ""}${String(row.amount)}`}
              amountTone={cents > 0 ? "ok" : undefined}
              amountSubLabel={balance}
              dataAttr="finances-activity-row"
            />
          );
        })}
      </PortalRecordListSurface>
    )}
  </div>;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "2026-09-22" -> { month: "Sep", day: "22" }, read as a calendar date (no timezone shift). */
function ledgerDateTile(iso: string): { month: string; day: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return { month: "", day: iso.slice(5) };
  const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1, 12)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return { month, day: String(Number(match[3])) };
}
