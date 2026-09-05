import Link from "next/link";
import {
  BOOK_DEMO_HREF,
  GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";

const primaryCls =
  "lp-btn lp-btn-blue inline-flex min-h-[46px] items-center justify-center rounded-[10px] px-[22px] text-[14.5px] font-medium";
const ghostCls =
  "lp-btn lp-btn-ghost inline-flex min-h-[46px] items-center justify-center rounded-[10px] px-[20px] text-[14.5px] font-medium";
const primaryLg = `${primaryCls} lp-lg`;
const ghostLg = `${ghostCls} lp-lg`;

type CtaPairProps = {
  primaryHref?: string;
  primaryLabel?: string;
  primaryAttr: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  secondaryAttr: string;
  large?: boolean;
  align?: "center" | "start";
};

/** Dual CTAs matching homepage: Get started + Book a demo. */
export function MarketingCtaPair({
  primaryHref = GET_STARTED_HREF,
  primaryLabel = "Get started",
  primaryAttr,
  secondaryHref = BOOK_DEMO_HREF,
  secondaryLabel = "Book a demo",
  secondaryAttr,
  large = false,
  align = "center",
}: CtaPairProps) {
  return (
    <div
      className={`lp-cta-row${align === "start" ? " lp-cta-row-start" : ""}`}
    >
      <Link href={primaryHref} data-attr={primaryAttr} className={large ? primaryLg : primaryCls}>
        {primaryLabel}
      </Link>
      <Link href={secondaryHref} data-attr={secondaryAttr} className={large ? ghostLg : ghostCls}>
        {secondaryLabel}
      </Link>
    </div>
  );
}

type EyebrowProps = { children: React.ReactNode };

/** Small brand pill used on marketing subpages. */
export function MarketingEyebrow({ children }: EyebrowProps) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--pl-line)] bg-[var(--pl-surface-raised)] px-3 py-1 text-[12px] font-medium tracking-[0.06em] text-[var(--pl-muted-fg)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--pl-brand)] shadow-[0_0_8px_color-mix(in_srgb,var(--pl-brand)_45%,transparent)]"
      />
      {children}
    </span>
  );
}
