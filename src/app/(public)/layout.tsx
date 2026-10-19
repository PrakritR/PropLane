import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { PublicFooter } from "@/components/layout/public-footer";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { HideOnNative } from "@/components/native/hide-on-native";
import { PublicMainTransition } from "@/components/motion/public-main-transition";
import { PublicLightThemeLock } from "@/components/providers/public-light-theme-lock";
import type { Metadata } from "next";
import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";
import { siteDisplayFont } from "@/components/marketing/fonts/site-display-font";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
import { publicSiteFont } from "@/components/public-site/fonts/inter-tight";
import { JourneyChromeSwitch } from "@/components/public-site/journey-chrome";
import { SiteTopBar } from "@/components/public-site/site-top-bar";
import { SiteFooter } from "@/components/public-site/site-footer";
import "@/components/public-site/public-site.css";

/**
 * Smart App Banner: iPhone Safari shows the native "Open in App Store" strip on
 * every public page. `app-argument` deep-links the installed app back to /app.
 */
export const metadata: Metadata = {
  itunes: { appId: IOS_APP_STORE_APP_ID, appArgument: "https://prop-lane.space/app" },
};

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const texting = await getPublicTextingConfig();
  return (
    <PublicTextingProvider value={texting}>
      <div className={`axis-page-frame relative flex min-h-screen flex-col ${siteDisplayFont.variable} ${publicSiteFont.variable}`}>
        <PublicLightThemeLock />
        <HideOnNative>
          <ChromeSubstrate variant="quiet" />
          {/* The prospect journey (browse, listing, tour, apply, phone-bound doors) wears the homepage's bar. */}
          <JourneyChromeSwitch journey={<SiteTopBar />}>
            <PublicNavbar />
          </JourneyChromeSwitch>
        </HideOnNative>
        <PublicMainTransition>
          <main className="flex-1">{children}</main>
        </PublicMainTransition>
        <HideOnNative>
          <JourneyChromeSwitch journey={<SiteFooter />}>
            <PublicFooter />
          </JourneyChromeSwitch>
        </HideOnNative>
      </div>
    </PublicTextingProvider>
  );
}
