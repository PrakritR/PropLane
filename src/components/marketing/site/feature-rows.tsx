import type { ReactNode } from "react";
import { SiteEyebrow } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

export type SiteFeatureRow = {
  eyebrow: string;
  title: string;
  body: ReactNode;
  mock: ReactNode;
};

/**
 * Alternating prose-and-screen rows — the Harvey/Cursor pattern: the product
 * on screen beside the sentence about it, never a card about the product.
 */
export function SiteFeatureRows({ rows }: { rows: SiteFeatureRow[] }) {
  return (
    <div className="space-y-16 sm:space-y-20 lg:space-y-24">
      {rows.map((row, i) => (
        <div
          key={row.title}
          className={cn(
            "grid items-center gap-8 lg:grid-cols-2 lg:gap-16",
            i % 2 === 1 && "lg:[&>*:first-child]:order-2",
          )}
        >
          <div className="min-w-0 max-w-[34rem]">
            <SiteEyebrow className="mb-3">{row.eyebrow}</SiteEyebrow>
            <h3 className="text-[clamp(1.5rem,2.8vw,2.1rem)] font-bold leading-tight tracking-[-0.025em] text-foreground">
              {row.title}
            </h3>
            <p className="mt-4 text-[15.5px] leading-relaxed text-muted">{row.body}</p>
          </div>
          <div className="mx-auto w-full max-w-[540px] min-w-0">{row.mock}</div>
        </div>
      ))}
    </div>
  );
}
