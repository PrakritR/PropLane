import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { CodexHeroWindow } from "@/components/marketing/site/codex-hero-window";
import { SITE_BTN_PRIMARY, SITE_BTN_SECONDARY, SITE_MEASURE } from "@/components/marketing/site/primitives";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import "@/components/marketing/site/site.css";

/**
 * The home hero — Codex-style, light mode (openai.com/codex reference,
 * captain 2026-09-25, third pass). A soft white/lavender gradient washing
 * into periwinkle and violet, centered: the PropLane mark in a rounded white
 * tile, a big "PropLane" title, a one-line caption carrying today's exact
 * tagline ("Property management for room rentals."), today's exact CTAs
 * (Start free — no card / Book a demo / the App Store badge) and fine print,
 * then — lower on the page, large and centered, overlapping the bottom of
 * the wash — the real manager portal, live and clickable, with the same
 * phone mockup and floating activity card today's live home page carries
 * (`CodexHeroWindow` → `/demo` in an iframe, opening on Dashboard).
 *
 * Nothing below the hero changes theme — the whole page stays light, same as
 * every other public page (captain: "use light mode only — remove dark mode
 * for the time being"). The top nav's wordmark text is hidden site-wide
 * (`public-navbar.tsx`'s `AxisLogoLink showWordmark={false}`) — only the mark
 * icon remains as the home link, so it doesn't compete with this hero's own
 * big "PropLane" title right below it.
 */
export function SiteHero() {
  return (
    <section
      className="site-hero relative overflow-hidden bg-[linear-gradient(180deg,#fbfcff_0%,#f3f5fc_100%)] pb-8 pt-16 sm:pb-14 sm:pt-20"
      aria-labelledby="site-hero-title"
      data-site-hero
    >
      {/* The wash: three soft periwinkle/violet glows, diagonal, behind the content. */}
      <div aria-hidden className="codex-hero-wash codex-hero-wash-a" />
      <div aria-hidden className="codex-hero-wash codex-hero-wash-b" />
      <div aria-hidden className="codex-hero-wash codex-hero-wash-c" />

      <div className={`${SITE_MEASURE} relative z-[1]`}>
        <div className="mx-auto flex max-w-[42rem] flex-col items-center text-center">
          <AxisLogoMark className="shadow-[0_20px_45px_-18px_rgba(40,99,240,0.45)]" />
          <h1
            id="site-hero-title"
            className="mt-6 text-[clamp(2.75rem,7vw,4.75rem)] font-bold leading-[1.02] tracking-[-0.04em] text-foreground"
          >
            PropLane
          </h1>
          <p className="mt-4 max-w-[32rem] text-[22px] font-normal leading-snug text-[#4a4e56]">
            Property management for room rentals.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href={GET_STARTED_HREF} data-attr="home-hero-get-started" className={SITE_BTN_PRIMARY}>
              Start free — no card
            </Link>
            <Link href={BOOK_DEMO_HREF} data-attr="home-hero-book-demo" className={SITE_BTN_SECONDARY}>
              Book a demo
            </Link>
            <AppStoreBadge dataAttr="home-hero-app-store" />
          </div>
          <p className="mt-4 text-[13px] text-muted">Free for one home · No card · Web and iPhone</p>
        </div>
      </div>

      {/* The product itself, lower on the page, large and centered, its
          shadow bleeding past the hero's own bottom edge. Deliberately
          OUTSIDE the text column's SITE_MEASURE — wider than the 1280px
          reading measure above it, but not edge to edge (captain, second
          pass): ~88-90vw on large screens, capped at 1320px, comfortable
          side gutters rather than a bare 24px. */}
      <div className="relative z-[1] mx-auto mt-14 w-[90vw] max-w-[1320px] sm:mt-16">
        <CodexHeroWindow />
      </div>
    </section>
  );
}
