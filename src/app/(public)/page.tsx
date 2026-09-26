import { SiteFaq } from "@/components/marketing/site/faq";
import { SiteHero } from "@/components/marketing/site/hero";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
import { SiteLifecycleRows } from "@/components/marketing/site/lifecycle-rows";
import { SitePricingTeaser } from "@/components/marketing/site/pricing-teaser";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";

/**
 * Home: one argument, top to bottom. Property management that runs itself →
 * here is who it is for → here is every stage of the product, real and
 * clickable → here is how switching in works → here is the price →
 * questions. Every section sits on the same shared measure
 * (site/primitives.tsx), drawn in the product's own components.
 *
 * Sections carry a heading and nothing else unless the lede says something the
 * heading cannot: a second sentence restating the first is what made this page
 * read as machine-written.
 *
 * Light throughout (captain 2026-09-25): the Codex-style hero (site/hero.tsx)
 * keeps its own soft gradient backdrop around the embedded portal window;
 * everything below it renders in the normal light theme, same as every other
 * public page.
 *
 * Captain 2026-09-26: the old hand-drawn "scroll story" (Communication inbox
 * + dashboard queue, four steps) is retired — Communication is now one more
 * row inside `SiteLifecycleRows`, built from the same real, static,
 * fixture-fed portal panels as every other row (see
 * `docs/agents/marketing-mocks.md`).
 *
 * No closing CTA band (captain 2026-09-25): the pricing teaser and the hero's
 * own "Start free" already carry the ask; SiteFinalCta stays on every other
 * public page but is deliberately dropped here.
 */
export default function HomePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <SiteHero />
      <SiteReplacesStrip />
      <SiteLifecycleRows />
      <SiteSwitchSteps />
      <SitePricingTeaser />
      <SiteFaq items={HOME_FAQ_ITEMS} />
    </div>
  );
}
