import type { ReactNode } from "react";
import { SiteIntro, SiteSection } from "@/components/marketing/site/primitives";

export type SiteFaqItem = { q: string; a: ReactNode };

/**
 * Questions, answered — a plain list of disclosure rows. Native <details> so
 * it works before hydration and needs no script; one open at a time is not a
 * rule worth JavaScript. The first row opens by default so the section never
 * reads as a wall of closed rows.
 */
export function SiteFaq({ items, id = "faq", title = "Questions, answered", lede }: { items: SiteFaqItem[]; id?: string; title?: string; lede?: ReactNode }) {
  return (
    <SiteSection id={id} tone="muted" ariaLabel={title}>
      <div className="mx-auto max-w-[760px]">
        <SiteIntro id={`${id}-title`} title={title} lede={lede} align="center" />
        <div className="divide-y divide-border rounded-2xl border border-border bg-card">
          {items.map((item, i) => (
            <details key={item.q} className="group px-5 sm:px-6" open={i === 0}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15.5px] font-bold text-foreground [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border text-muted transition-transform duration-200 group-open:rotate-180">
                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 8l5 5 5-5" />
                  </svg>
                </span>
              </summary>
              <div className="pb-5 text-[14.5px] leading-relaxed text-muted">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </SiteSection>
  );
}
