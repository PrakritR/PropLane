import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { PublicFooter } from "@/components/layout/public-footer";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { HideOnNative } from "@/components/native/hide-on-native";
import { PublicMainTransition } from "@/components/motion/public-main-transition";
import { PublicLightThemeLock } from "@/components/providers/public-light-theme-lock";
import { publicSiteFont } from "@/components/public-site/fonts/inter-tight";
import "@/components/public-site/public-site.css";
import type { Metadata } from "next";
import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";
import { siteDisplayFont } from "@/components/marketing/fonts/site-display-font";
import {
  homeSwissFont,
  homeSwissCoverFont,
} from "@/components/marketing/fonts/home-swiss-font";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
// Keep home styles/fonts in the layout's first flush. Page-level stylesheet
// suspension otherwise exposes the short loading shell and shifts the footer.
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

/**
 * Smart App Banner: iPhone Safari shows the native "Open in App Store" strip on
 * every public page. `app-argument` deep-links the installed app back to /app.
 */
export const metadata: Metadata = {
  itunes: {
    appId: IOS_APP_STORE_APP_ID,
    appArgument: "https://prop-lane.space/app",
  },
};

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const texting = await getPublicTextingConfig();
  return (
    <PublicTextingProvider value={texting}>
      <div
        className={`axis-page-frame relative flex min-h-screen flex-col ${siteDisplayFont.variable} ${homeSwissFont.variable} ${homeSwissCoverFont.variable} ${publicSiteFont.variable}`}
      >
        <PublicLightThemeLock />
        <HideOnNative>
          <ChromeSubstrate variant="quiet" />
          <PublicNavbar texting={texting} />
        </HideOnNative>
        <PublicMainTransition>
          <main className="flex-1">{children}</main>
        </PublicMainTransition>
        <HideOnNative>
          <PublicFooter texting={texting} />
        </HideOnNative>
      </div>
    </PublicTextingProvider>
  );
}
