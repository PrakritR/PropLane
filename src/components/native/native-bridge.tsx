"use client";

import { isNativeDeepLinkPath } from "@/lib/auth/native-entry-paths";
import { redirectNativeFromMarketing } from "@/lib/auth/native-welcome-redirect";
import { loadPublicExtraListingsFromServer } from "@/lib/demo-property-pipeline";
import { detectNativePlatformSync, tagHtmlNativePlatform } from "@/lib/native/detect-native";
import { installNativeZoomLock } from "@/lib/native/disable-native-zoom";
import { handleNativeOAuthReturnUrl, isNativeOAuthInProgress } from "@/lib/native/open-url";
import { nativeOAuthMarketingSiteMessage } from "@/lib/auth/oauth-failure-messages";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getNativeInfo, registerPushIfGranted, resendCachedToken } from "@/lib/native/push-client";
import { recordAppLaunch } from "@/lib/native/app-review";
import { useEffect } from "react";

async function redirectNativeFromMarketingPage(): Promise<void> {
  const supabase = createSupabaseBrowserClient();
  await redirectNativeFromMarketing(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { session: user ? { user } : null };
  });
}

async function recoverFromMarketingDuringOAuth(): Promise<void> {
  if (!isNativeOAuthInProgress()) return;
  const { pathname, search, hash } = window.location;
  if (pathname !== "/" && pathname !== "") return;

  const params = new URLSearchParams(search);
  if (params.get("code") || params.get("error")) {
    window.location.replace(`/auth/callback?${params.toString()}${hash}`);
    return;
  }

  window.location.replace(
    `/auth/sign-in?error=oauth&message=${encodeURIComponent(nativeOAuthMarketingSiteMessage())}`,
  );
}

/**
 * Runs only inside the Capacitor native shell (the iOS/Android app). On the web
 * it renders nothing and does no work — Capacitor modules are imported lazily.
 */
export function NativeBridge() {
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      try {
        const syncPlatform = detectNativePlatformSync();
        const { isNative, platform } = syncPlatform
          ? { isNative: true as const, platform: syncPlatform }
          : await getNativeInfo();
        if (disposed || !isNative) return;

        tagHtmlNativePlatform(platform);
        recordAppLaunch();
        void loadPublicExtraListingsFromServer().catch(() => {});
        const removeZoomLock = installNativeZoomLock();
        cleanups.push(removeZoomLock);

        try {
          const { SplashScreen } = await import("@capacitor/splash-screen");
          await SplashScreen.hide();
        } catch {
          /* splash plugin unavailable — non-fatal */
        }

        try {
          const { StatusBar, Style } = await import("@capacitor/status-bar");
          await StatusBar.setOverlaysWebView({ overlay: true });
          await StatusBar.setStyle({ style: Style.Dark });
          if (platform === "android") {
            await StatusBar.setBackgroundColor({ color: "#080b14" });
          }
        } catch {
          /* status bar plugin unavailable — non-fatal */
        }

        try {
          await registerPushIfGranted();
        } catch (err) {
          console.error("Push registration failed", err);
        }

        try {
          const { App } = await import("@capacitor/app");
          const launch = await App.getLaunchUrl();
          if (launch?.url) {
            const handled = await handleNativeOAuthReturnUrl(launch.url);
            if (handled) return;
          }

          const resume = await App.addListener("resume", () => {
            recordAppLaunch();
            void resendCachedToken().catch(() => {});
            void redirectNativeFromMarketingPage().catch(() => {});
            void recoverFromMarketingDuringOAuth().catch(() => {});
          });
          cleanups.push(() => void resume.remove());

          const urlOpen = await App.addListener("appUrlOpen", (event) => {
            if (!event.url) return;
            void (async () => {
              const handled = await handleNativeOAuthReturnUrl(event.url);
              if (handled) return;

              try {
                const opened = new URL(event.url);
                if (!isNativeDeepLinkPath(opened.pathname)) return;
                const target = `${opened.pathname}${opened.search}${opened.hash}`;
                window.location.assign(target);
              } catch {
                /* ignore malformed deep links */
              }
            })();
          });
          cleanups.push(() => void urlOpen.remove());
        } catch {
          /* app plugin unavailable — non-fatal */
        }

        await recoverFromMarketingDuringOAuth();
        await redirectNativeFromMarketingPage();
      } catch {
        /* native bridge init is best-effort */
      }
    })();

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return null;
}
