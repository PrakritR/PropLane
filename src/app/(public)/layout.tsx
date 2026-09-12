import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { PublicFooter } from "@/components/layout/public-footer";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { HideOnNative } from "@/components/native/hide-on-native";
import { PublicMainTransition } from "@/components/motion/public-main-transition";
import { PublicLightThemeLock } from "@/components/providers/public-light-theme-lock";
import type { Metadata } from "next";
import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";

/**
 * Smart App Banner: iPhone Safari shows the native "Open in App Store" strip on
 * every public page. `app-argument` deep-links the installed app back to /app.
 */
export const metadata: Metadata = {
  itunes: { appId: IOS_APP_STORE_APP_ID, appArgument: "https://prop-lane.space/app" },
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="axis-page-frame relative flex min-h-screen flex-col">
      <PublicLightThemeLock />
      <HideOnNative>
        <ChromeSubstrate variant="quiet" />
        <PublicNavbar />
      </HideOnNative>
      <PublicMainTransition>
        <main className="flex-1">{children}</main>
      </PublicMainTransition>
      <HideOnNative>
        <PublicFooter />
      </HideOnNative>
    </div>
  );
}
