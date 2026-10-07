import "@/components/marketing/landing-proplane.css";
import { SitePage } from "@/components/marketing/site/site-page";

type ShellProps = {
  children: React.ReactNode;
  className?: string;
};

/**
 * Wraps public marketing pages in the same PropLane token surface as the homepage
 * (`lp-root` → cool white / near-black, light=blue / dark=purple brand), inside
 * `SitePage`, so the wavy atmosphere and the display heading face run behind it
 * (`site-display.css` restyles the `lp-page-*` classes under `.site-page`).
 */
export function MarketingPageShell({ children, className = "" }: ShellProps) {
  return <SitePage className={`lp-root lp-page ${className}`.trim()}>{children}</SitePage>;
}

type SectionProps = {
  children: React.ReactNode;
  className?: string;
  id?: string;
  narrow?: boolean;
};

export function MarketingSection({ children, className = "", id, narrow }: SectionProps) {
  return (
    <section id={id} className={`lp-page-section ${className}`.trim()}>
      <div className={narrow ? "lp-w" : "lp-w-wide"}>{children}</div>
    </section>
  );
}

type HeroProps = {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  align?: "center" | "start";
};

export function MarketingHero({
  eyebrow,
  title,
  subtitle,
  children,
  align = "center",
}: HeroProps) {
  return (
    <header
      className={`lp-page-hero ${align === "start" ? "lp-page-hero--start" : ""}`.trim()}
    >
      <div className="lp-w">
        {eyebrow ? (
          <p className="lp-page-eyebrow">
            <span aria-hidden className="lp-page-eyebrow-dot" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="lp-page-title">{title}</h1>
        {subtitle ? <p className="lp-page-lede">{subtitle}</p> : null}
        {children}
      </div>
    </header>
  );
}
