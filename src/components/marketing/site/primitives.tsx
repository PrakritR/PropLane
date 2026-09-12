import Link from "next/link";
import type { ReactNode } from "react";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { cn } from "@/lib/utils";

/**
 * The public site's design system — one measure, one type scale, one pair of
 * buttons — shared by every marketing page so Home, Pricing, the audience pages
 * and the rest read as one site.
 *
 * Everything is drawn in the product's own tokens (`--pl-*` through Tailwind's
 * `primary`, `card`, `border`, `muted`) so the marketing pages look like the
 * product they sell, in light and dark alike.
 */

/** The page measure: 1100px, with the phone gutters every section shares. */
export const SITE_MEASURE = "mx-auto w-full max-w-[1100px] px-5 sm:px-6";

export function SiteSection({
  id,
  children,
  className,
  tone = "plain",
  ariaLabel,
  ariaLabelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  /** `muted` is the alternating quiet band; `plain` sits on the page canvas. */
  tone?: "plain" | "muted";
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        "py-16 sm:py-20 lg:py-24",
        tone === "muted" && "bg-[var(--pl-surface-muted)] [html[data-theme=dark]_&]:bg-white/[0.03]",
        className,
      )}
    >
      <div className={SITE_MEASURE}>{children}</div>
    </section>
  );
}

export function SiteEyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[12.5px] font-bold uppercase tracking-[0.08em] text-primary", className)}>{children}</p>
  );
}

export function SiteHeading({
  children,
  id,
  as: Tag = "h2",
  className,
}: {
  children: ReactNode;
  id?: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <Tag
      id={id}
      className={cn(
        Tag === "h1"
          ? "text-[clamp(2.4rem,5.4vw,3.9rem)] font-bold leading-[1.02] tracking-[-0.035em] text-foreground"
          : Tag === "h2"
            ? "text-[clamp(1.75rem,3.4vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.03em] text-foreground"
            : "text-[19px] font-bold leading-snug tracking-tight text-foreground",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SiteLede({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("max-w-[56ch] text-[16px] leading-relaxed text-muted sm:text-[17px]", className)}>{children}</p>
  );
}

/** Eyebrow + heading + lede, the way every section opens. */
export function SiteIntro({
  eyebrow,
  title,
  lede,
  id,
  align = "left",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  id?: string;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={cn("mb-10 sm:mb-12", align === "center" && "mx-auto flex flex-col items-center text-center", className)}>
      {eyebrow ? <SiteEyebrow className="mb-3">{eyebrow}</SiteEyebrow> : null}
      <SiteHeading id={id}>{title}</SiteHeading>
      {lede ? <SiteLede className={cn("mt-4", align === "center" && "mx-auto")}>{lede}</SiteLede> : null}
    </div>
  );
}

const BTN_BASE =
  "inline-flex min-h-[46px] items-center justify-center gap-2 rounded-full px-6 text-[14.5px] font-bold transition-[transform,box-shadow,filter,background-color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";

export const SITE_BTN_PRIMARY = cn(
  BTN_BASE,
  "bg-primary text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-0.5 hover:brightness-105 active:translate-y-px",
);
export const SITE_BTN_SECONDARY = cn(
  BTN_BASE,
  "border border-border bg-card text-foreground hover:border-foreground/25 hover:bg-accent/40",
);
export const SITE_BTN_LARGE = "min-h-[52px] px-8 text-[15.5px]";

/**
 * The two doors, on every page: Start free (the $0 plan, no card) and Book a
 * demo. The primary reads "Start free" everywhere so the button says what it
 * does — a manager is not filling in a form, they are starting a plan.
 */
export function SiteCtaPair({
  primaryAttr,
  secondaryAttr,
  primaryHref = GET_STARTED_HREF,
  primaryLabel = "Start free",
  secondaryHref = BOOK_DEMO_HREF,
  secondaryLabel = "Book a demo",
  large = false,
  className,
  note,
}: {
  primaryAttr: string;
  secondaryAttr: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  large?: boolean;
  className?: string;
  /** The fine print under the buttons: "Free for one home · no card". */
  note?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-3", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={primaryHref} data-attr={primaryAttr} className={cn(SITE_BTN_PRIMARY, large && SITE_BTN_LARGE)}>
          {primaryLabel}
        </Link>
        <Link href={secondaryHref} data-attr={secondaryAttr} className={cn(SITE_BTN_SECONDARY, large && SITE_BTN_LARGE)}>
          {secondaryLabel}
        </Link>
      </div>
      {note ? <p className="text-[13px] text-muted">{note}</p> : null}
    </div>
  );
}

/* ───────────────────────── product mocks ─────────────────────────
 * Every screen on the site is a real screen from the product, drawn small:
 * the same rows, chips and avatars the portal uses. These are the pieces. */

export function MockFrame({
  title,
  children,
  className,
  aside,
}: {
  /** The window's title bar text, e.g. "Applications · Pending". */
  title: ReactNode;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_24px_60px_-32px_rgba(11,27,58,0.35)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
        <span className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          <span aria-hidden className="flex gap-1">
            <i className="block h-2 w-2 rounded-full bg-border" />
            <i className="block h-2 w-2 rounded-full bg-border" />
            <i className="block h-2 w-2 rounded-full bg-border" />
          </span>
          {title}
        </span>
        {aside}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </div>
  );
}

export function MockAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-white",
        className,
      )}
    >
      {initials}
    </span>
  );
}

export type MockTone = "neutral" | "info" | "good" | "warn" | "bad";

const TONE_CLASS: Record<MockTone, string> = {
  neutral: "bg-accent/70 text-foreground/80",
  info: "bg-[var(--status-approved-bg)] text-[var(--status-approved-fg)]",
  good: "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  warn: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  // The overdue token on its tint measures 3.99:1 at chip size; a deeper red clears AA.
  bad: "bg-[var(--status-overdue-bg)] text-[#b91c1c] [html[data-theme=dark]_&]:text-[var(--status-overdue-fg)]",
};

export function MockChip({ tone = "neutral", children }: { tone?: MockTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold", TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

/** A portal list row: avatar, two lines, and a chip or action on the right. */
export function MockRow({
  name,
  title,
  sub,
  right,
  avatar = true,
  className,
}: {
  name: string;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  avatar?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl px-2 py-2", className)}>
      {avatar ? <MockAvatar name={name} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-foreground">{title}</span>
        {sub ? <span className="block truncate text-[12px] text-muted">{sub}</span> : null}
      </span>
      {right}
    </div>
  );
}

/** A tiny primary/secondary button inside a mock — never a real control. */
export function MockButton({ primary = false, children }: { primary?: boolean; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[12px] font-bold",
        primary ? "bg-primary text-white" : "border border-border bg-card text-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** The approve · edit · discard trio that ends every AI draft in the product. */
export function MockApproveRow() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MockButton primary>Approve &amp; send</MockButton>
      <MockButton>Edit</MockButton>
      <span className="text-[12px] font-semibold text-muted">Discard</span>
    </div>
  );
}

/** A drafted message from the assistant, the site's recurring object. */
export function MockDraft({ children, label = "PropLane drafted a reply" }: { children: ReactNode; label?: string }) {
  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-bold text-primary">
        <span aria-hidden>✦</span> {label}
      </p>
      <p className="text-[13px] leading-relaxed text-foreground">{children}</p>
    </div>
  );
}
