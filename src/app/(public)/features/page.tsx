import type { Metadata } from "next";
import { SiteLifecycleRows } from "@/components/marketing/site/lifecycle-rows";
import { SiteSwitchSteps } from "@/components/marketing/site/switch-steps";
import { SiteReplacesStrip } from "@/components/marketing/site/replaces-strip";
import { SiteFaq } from "@/components/marketing/site/faq";
import { HOME_FAQ_ITEMS } from "@/components/marketing/site/home-faq-items";
export const metadata: Metadata = {
  title: "Features",
  description:
    "Explore PropLane tours, applications, leases, rent collection and services.",
  alternates: { canonical: "/features" },
};
export default function FeaturesPage() {
  return (
    <div className="min-w-0">
      <h1 className="px-6 pt-12 text-center text-4xl font-semibold tracking-tight sm:text-6xl">
        One place to run your properties.
      </h1>
      <SiteReplacesStrip />
      <SiteLifecycleRows />
      <SiteSwitchSteps />
      <SiteFaq items={HOME_FAQ_ITEMS} />
    </div>
  );
}
