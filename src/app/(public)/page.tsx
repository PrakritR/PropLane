import { ResidentLifecycleAtmosphere } from "@/components/marketing/resident-lifecycle-atmosphere";
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
 *   1. Akhil's hero, headline "Your AI property / management assistant." on two
 *      lines with Start free, Book a demo and the App Store badge, and right under
 *      it the guided demo: it plays itself, the account menu in its top bar
 *      switches between the Manager, Resident and Vendor portals, and every
 *      sidebar tab opens its real panel. It replaces `SiteHero`.
 *
 *      The whole page sits on one continuous wavy background (captain 2026-10-07):
 *      `ResidentLifecycleAtmosphere variant="page"` behind every section, the
 *      sections themselves transparent, and the site top bar blending into it at
 *      the top (`public-navbar.tsx`).
 *      One phone stays on screen (sticky from `lg`) beside the demo, the strip and the
 *      lifecycle rows, always typing the next message, so those two sections are the
 *      demo's children (`ResidentLifecyclePrototypes`).
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
    <div className="home-wavy min-h-0 flex-1">
      <ResidentLifecycleAtmosphere variant="page" />
      <ResidentLifecyclePrototypes>
        <SiteReplacesStrip />
        <SiteLifecycleRows />
      </ResidentLifecyclePrototypes>
      <SiteSwitchSteps />
      <SitePricingTeaser />
      <SiteFaq items={HOME_FAQ_ITEMS} />
    </div>
  );
}
