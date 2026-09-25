import { SiteAudienceSwitch } from "@/components/marketing/site/audience-switch";
import { SiteFaq } from "@/components/marketing/site/faq";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import { SiteHero } from "@/components/marketing/site/hero";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
import { SitePricingTeaser } from "@/components/marketing/site/pricing-teaser";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteStory } from "@/components/marketing/site/story";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";

/**
 * Home: one argument, top to bottom. Property management that runs itself →
 * here is the one feature, told as a playable scroll story → here is who it is
 * for → here is how switching in works → here is the price → start. Every
 * section sits on the same 1100px measure, drawn in the product's own
 * components.
 *
 * Sections carry a heading and nothing else unless the lede says something the
 * heading cannot: a second sentence restating the first is what made this page
 * read as machine-written.
 *
 * Everything below the Codex-style hero keeps its exact real copy and order,
 * restyled to the dark look (captain 2026-09-25): a `data-theme="dark"`
 * scope flips every section's own tokens (`--foreground`, `--card`,
 * `--border`, `--primary`, `--pl-surface-muted`, …) to their existing dark
 * values — the product's own dark theme, not a duplicated set of styles —
 * without touching the page-wide light theme lock the top nav still sits on.
 */
export default function HomePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <SiteHero />
      <div data-theme="dark" className="bg-black">
        <SiteReplacesStrip />
        <SiteStory />
        <SiteAudienceSwitch />
        <SiteSwitchSteps />
        <SitePricingTeaser />
        <SiteFaq items={HOME_FAQ_ITEMS} />
        <SiteFinalCta primaryAttr="home-closing-get-started" secondaryAttr="home-closing-book-demo" />
      </div>
    </div>
  );
}
