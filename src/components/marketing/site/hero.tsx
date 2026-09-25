import { CodexHeroWindow } from "@/components/marketing/site/codex-hero-window";
import "@/components/marketing/site/site.css";

/**
 * The home hero — Codex-style (openai.com/codex reference, captain
 * 2026-09-25): a black page, a soft diagonal blue/violet gradient wash, and
 * one big rounded dark app window overlapping it. No headline, no eyebrow,
 * no CTA row here — the window IS the pitch: the real manager portal, live
 * and clickable (`CodexHeroWindow` → `/demo` in an iframe). The buttons that
 * used to live in this hero (Start free, Book a demo) still exist, just
 * lower on the page (`SiteFinalCta`) and in the untouched top nav's Portal
 * button — nothing is dropped, only moved.
 *
 * `h1` stays for SEO/screen readers (same copy the visible headline used to
 * carry) even though nothing shows it — a home page should still name itself
 * to an agent that can't see the window.
 *
 * Colours are explicit (not theme tokens): the public pages are locked to
 * the light theme (`PublicLightThemeLock`), and this section is deliberately
 * black either way.
 */
export function SiteHero() {
  return (
    <section
      className="site-hero relative overflow-hidden bg-black px-2.5 pb-10 pt-4 sm:px-8 sm:pb-16 sm:pt-6"
      aria-labelledby="site-hero-title"
      data-site-hero
    >
      <h1 id="site-hero-title" className="sr-only">
        Property management that runs itself
      </h1>

      {/* The wash: three soft radial glows, blue → violet, diagonal. */}
      <div aria-hidden className="codex-hero-wash codex-hero-wash-a" />
      <div aria-hidden className="codex-hero-wash codex-hero-wash-b" />
      <div aria-hidden className="codex-hero-wash codex-hero-wash-c" />

      <div className="relative z-[1]">
        <CodexHeroWindow />
      </div>
    </section>
  );
}
