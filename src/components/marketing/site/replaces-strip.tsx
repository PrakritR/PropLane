import { SITE_MEASURE } from "@/components/marketing/site/primitives";

const REPLACES: { from: string; to: string }[] = [
  { from: "the spreadsheet", to: "a ledger" },
  { from: "group texts", to: "one inbox" },
  { from: "chasing Zelle", to: "rent that collects itself" },
  { from: "PDF leases", to: "drafted & e-signed" },
  { from: "“who’s the plumber?”", to: "vendors that show up" },
];

/** What a manager stops doing by hand — the strip under the hero, in place of logos we do not have. */
export function SiteReplacesStrip() {
  return (
    <div className="border-b border-border/70 bg-[var(--pl-surface-muted)] [html[data-theme=dark]_&]:bg-white/[0.03]">
      <div className={`${SITE_MEASURE} flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-[13px]`}>
        <span className="font-bold uppercase tracking-[0.08em] text-muted">Replaces</span>
        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {REPLACES.map((r) => (
            <li key={r.from} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-muted line-through decoration-muted/60">{r.from}</span>
              <span aria-hidden className="text-muted">→</span>
              <span className="font-semibold text-foreground">{r.to}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
