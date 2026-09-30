import { SiteFaq } from "@/components/marketing/site/faq";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
import { ResidentLifecyclePrototypes } from "@/components/marketing/resident-lifecycle-prototypes";
import { SitePricingTeaser } from "@/components/marketing/site/pricing-teaser";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";

/** The hero and local walkthrough lead into the existing public sections. */
export default function HomePage() {
  return (
    <div className="relative min-h-0 flex-1">
      <ResidentLifecyclePrototypes />
      <SiteReplacesStrip />
      <SiteSwitchSteps />
      <SitePricingTeaser />
      <SiteFaq items={HOME_FAQ_ITEMS} />
    </div>
  );
}
