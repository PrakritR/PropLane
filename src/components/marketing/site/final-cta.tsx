import type { ReactNode } from "react";
import { SITE_MEASURE, SiteCtaPair } from "@/components/marketing/site/primitives";

/** The last band on every page: one line, both doors. */
export function SiteFinalCta({
  title = "Start with one home. Free.",
  lede = "List it in four answers. The first approval is yours in about ten minutes.",
  primaryAttr,
  secondaryAttr,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: {
  title?: ReactNode;
  lede?: ReactNode;
  primaryAttr: string;
  secondaryAttr: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <section aria-label="Get started" className="py-20 sm:py-24">
      <div className={`${SITE_MEASURE} flex flex-col items-center text-center`}>
        <h2 className="text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-[1.05] tracking-[-0.035em] text-foreground">{title}</h2>
        <p className="mt-4 max-w-[50ch] text-[16.5px] leading-relaxed text-muted">{lede}</p>
        <SiteCtaPair
          className="mt-8 items-center"
          large
          primaryAttr={primaryAttr}
          secondaryAttr={secondaryAttr}
          primaryHref={primaryHref}
          primaryLabel={primaryLabel}
          secondaryHref={secondaryHref}
          secondaryLabel={secondaryLabel}
        />
      </div>
    </section>
  );
}
