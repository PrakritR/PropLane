import { SiteAudienceSwitch } from "@/components/marketing/site/audience-switch";
import { SiteFaq } from "@/components/marketing/site/faq";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import { SiteHero } from "@/components/marketing/site/hero";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
import { SitePricingTeaser } from "@/components/marketing/site/pricing-teaser";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteSteps } from "@/components/marketing/site/steps";
import { SiteStory } from "@/components/marketing/site/story";

/**
 * Home: one argument, top to bottom. The AI does the busywork, you approve →
 * here is exactly how → here is the one feature, told as a scroll story → here is who it is for →
 * here is the price → start. Every section sits on the same
 * 1100px measure, drawn in the product's own components.
 */
export default function HomePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <SiteHero />
      <SiteReplacesStrip />
      <SiteSteps />
      <SiteStory />
      <SiteAudienceSwitch />
      <SitePricingTeaser />
      <SiteFaq items={HOME_FAQ_ITEMS} lede="The things people ask us before signing up — plain answers, no fine print." />
      <SiteFinalCta primaryAttr="home-closing-get-started" secondaryAttr="home-closing-book-demo" />
    </div>
  );
}
