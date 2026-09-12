import type { ReactNode } from "react";
import { SiteIntro, SiteSection } from "@/components/marketing/site/primitives";

export type SiteFaqItem = { q: string; a: ReactNode };

/**
 * Questions, answered — a plain list of disclosure rows. Native <details> so
 * it works before hydration and needs no script; one open at a time is not a
 * rule worth JavaScript.
 */
export function SiteFaq({ items, id = "faq", title = "Questions, answered", lede }: { items: SiteFaqItem[]; id?: string; title?: string; lede?: ReactNode }) {
  return (
    <SiteSection id={id} tone="muted" ariaLabel={title}>
      <div className="mx-auto max-w-[760px]">
        <SiteIntro id={`${id}-title`} title={title} lede={lede} align="center" />
        <div className="divide-y divide-border rounded-2xl border border-border bg-card">
          {items.map((item) => (
            <details key={item.q} className="group px-5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15.5px] font-bold text-foreground [&::-webkit-details-marker]:hidden">
                <span>{item.q}</span>
                <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border text-muted transition-transform group-open:rotate-45">
                  +
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
