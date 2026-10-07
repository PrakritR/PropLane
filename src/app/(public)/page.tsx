import { SiteFaq } from "@/components/marketing/site/faq";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
import { ResidentLifecyclePrototypes } from "@/components/marketing/resident-lifecycle-prototypes";
import { SiteLifecycleRows } from "@/components/marketing/site/lifecycle-rows";
import { SitePricingTeaser } from "@/components/marketing/site/pricing-teaser";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";

/**
 * Home page order (captain 2026-10-06, replacing the 2026-09-25 order):
 *
 *   1. Akhil's hero, headline "Your AI property management assistant." with
 *      Start free, Book a demo and the App Store badge (captain 2026-10-06; no
 *      "Follow the story" link), and right under it the guided demo: Manager, Resident and Vendor portals, a tab per stage
 *      with autoplay, every sidebar tab opening its real panel. It replaces
 *      `SiteHero`.
 *   2. Replaces strip.
 *   3. Lifecycle rows ("From first tour to fixed faucet.").
 *   4. Switching steps (the import).
 *   5. Pricing teaser.
 *   6. FAQ, deliberately the last section: no closing CTA band (captain
 *      2026-09-25), the pricing teaser and the hero's own "Start free" carry the
 *      ask.
 *
 * Sections 2 to 6 are unchanged from before the demo. They keep drawing the real,
 * static, fixture-fed portal panels described in `docs/agents/marketing-mocks.md`.
 */
export default function HomePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <ResidentLifecyclePrototypes />
      <SiteReplacesStrip />
      <SiteLifecycleRows />
      <SiteSwitchSteps />
      <SitePricingTeaser />
      <SiteFaq items={HOME_FAQ_ITEMS} />
    </div>
  );
}
