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
 * Never scrolls sideways and never hides an item: the five pairs sit centered and wrap onto a
 * second (or, on a phone, third) centered line as the width narrows.
 */
export function SiteReplacesStrip() {
  return (
    <div className="border-b border-border/40">
      <div className={`${SITE_MEASURE} flex flex-col items-center gap-2.5 py-4 text-center`}>
        <span className="text-[11.5px] font-extrabold uppercase tracking-[0.12em] text-muted">Replaces</span>
        <ul className="mx-auto flex max-w-[60rem] flex-wrap items-center justify-center gap-x-1.5 gap-y-1.5 text-[11px] sm:gap-x-2 sm:gap-y-2 sm:text-[12.5px] xl:text-[13px]">
          {REPLACES.map((r) => (
            <li
              key={r.from}
              className="flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-left sm:gap-1.5 sm:px-3 sm:py-1"
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
