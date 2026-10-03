"use client";
import { loadFinancialActivity, invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { useEffect, useState } from "react";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { HOUSEHOLD_CHARGES_EVENT } from "@/lib/household-charges";
import { useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import type { ReportResult } from "@/lib/reports/types";
import { cn } from "@/lib/utils";

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
    {error ? <p role="alert" className="py-6">{error}</p> : !report ? <p role="status" className="py-6">Loading activity…</p> : rows.length === 0 ? <p className="py-6 text-muted">No entries found.</p> : <div className="divide-y divide-border">{rows.map(row => <div key={String(row.id)} className="flex items-center gap-3 py-4">
      <time className="grid size-12 shrink-0 place-items-center rounded-lg bg-accent text-xs tabular-nums" dateTime={String(row.date)}>{String(row.date).slice(5)}</time>
      <div className="min-w-0 flex-1"><div className="truncate font-medium">{String(row.who || row.description)}</div><div className="truncate text-sm">{[row.description, row.property].filter(Boolean).join(" · ")}</div><div className="text-xs text-muted">{String(row.category)} · {String(row.source)}</div></div>
      <div className={cn("shrink-0 font-semibold tabular-nums", Number(row.amountCents) > 0 && "text-emerald-600")}>{Number(row.amountCents) > 0 ? "+" : ""}{String(row.amount)}{typeof row.runningBalanceCents === "number" ? <span className="mt-1 block text-xs font-normal text-muted">Balance {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(row.runningBalanceCents / 100)}</span> : null}</div>
    </div>)}</div>}
  </div>;
}
