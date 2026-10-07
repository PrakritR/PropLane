import { SITE_MEASURE } from "@/components/marketing/site/primitives";

const REPLACES: { from: string; to: string }[] = [
  { from: "the spreadsheet", to: "a ledger" },
  { from: "group texts", to: "Communication" },
  { from: "chasing rent by text", to: "rent that collects itself" },
  { from: "PDF leases", to: "drafted & e-signed" },
  { from: "“who’s the plumber?”", to: "vendors that show up" },
];

/**
 * What a manager stops doing by hand — the strip under the hero, in place of logos we do not have.
 * It wraps onto a second line instead of scrolling: no item is ever cut off at the strip's edge.
 */
export function SiteReplacesStrip() {
  return (
    <div className="border-b border-border/40">
      <div
        className={`${SITE_MEASURE} flex flex-wrap items-center gap-x-4 gap-y-2.5 py-4 text-[13.5px] max-[379px]:hidden xl:gap-x-2.5 xl:text-[12px]`}
      >
        <span className="w-full shrink-0 text-[11.5px] font-extrabold uppercase tracking-[0.12em] text-muted sm:w-auto">Replaces</span>
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-2 xl:gap-1.5">
          {REPLACES.map((r) => (
            <li
              key={r.from}
              className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 sm:whitespace-nowrap xl:gap-1 xl:px-2 xl:py-0.5"
            >
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
