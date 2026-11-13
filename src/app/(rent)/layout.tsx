import { PublicShell } from "@/components/layout/public-shell";
import "@/components/public-site/public-site.css";
import type { Metadata } from "next";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
// The same first-flush styles as the (public) layout: /rent is the same public site, minus the texting number.
import "@/components/marketing/texting-home.css";
import "@/components/marketing/home-scroll-stage.css";
import "@/components/marketing/home-number-hero.css";
import "@/components/marketing/resident-lifecycle-phone.css";
import "@/components/marketing/resident-lifecycle-atmosphere.css";
import "@/components/marketing/site/pricing-cards.css";
import "@/components/marketing/home-swiss.css";
import "@/components/marketing/home-viewport.css";
import "@/components/marketing/home-iphone-phone.css";
import "@/components/marketing/home-software-demo.css";
import "@/components/marketing/public-footer-band.css";

export const metadata: Metadata = {
  itunes: {
    appId: IOS_APP_STORE_APP_ID,
    appArgument: "https://prop-lane.space/app",
  },
};

/**
 * `/rent/*` is the WEB channel: a request made on the website is answered on the website. The chrome (navbar, footer)
 * still takes no number, so the sms href stays out of the menu and the footer. The configured PropLane line reaches
 * the page CONTENT only, through the nested texting provider, for the listing's "Text us" control and nothing else
 * (captain, Nov 12, design-1112 §5.1): `getPublicTextingConfig()` is the one source, never a literal, and with no
 * number configured "Text us" is not drawn.
 */
export default async function RentLayout({ children }: { children: React.ReactNode }) {
  const texting = await getPublicTextingConfig().catch(() => ({ phone: null, smsHref: null }));
  return (
    <PublicShell texting={{ phone: null, smsHref: null }}>
      <PublicTextingProvider value={texting}>{children}</PublicTextingProvider>
    </PublicShell>
  );
}
