import type { ReactNode } from "react";
import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { PublicFooter } from "@/components/layout/public-footer";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { HideOnNative } from "@/components/native/hide-on-native";
import { PublicMainTransition } from "@/components/motion/public-main-transition";
import { PublicLightThemeLock } from "@/components/providers/public-light-theme-lock";
import { publicSiteFont } from "@/components/public-site/fonts/inter-tight";
import { homeSwissFont, homeSwissCoverFont } from "@/components/marketing/fonts/home-swiss-font";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";

/**
 * The public site's chrome (navbar, main, footer, texting context), shared by the `(public)` layout and the `/rent`
 * web-channel layout. The only difference is the `texting` snapshot: `(public)` passes the real one, `/rent` passes
 * none, so the PropLane number and sms href never reach a /rent page's payload.
 */
export function PublicShell({ texting, children }: { texting: PublicTextingConfig; children: ReactNode }) {
  return (
    <PublicTextingProvider value={texting}>
      <div
        className={`axis-page-frame relative flex min-h-screen flex-col ${homeSwissFont.variable} ${homeSwissCoverFont.variable} ${publicSiteFont.variable}`}
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
