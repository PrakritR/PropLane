import type { Metadata } from "next";
import { MarketingPageShell } from "@/components/marketing/marketing-page-shell";
import { SiteAppPage } from "@/components/marketing/site/app-page";

export const metadata: Metadata = {
  title: "PropLane for iPhone",
  description: "The same approval queue on your phone: applications, leases, residents and inspections, with push for anything that needs your OK.",
};

export default function MobileAppDownloadPage() {
  return (
    <MarketingPageShell>
      <SiteAppPage />
    </MarketingPageShell>
  );
}
