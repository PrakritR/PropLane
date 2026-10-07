"use client";

import { ChromeSubstrate } from "@/components/brand/chrome-substrate";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { PublicFooter } from "@/components/layout/public-footer";
import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import Link from "next/link";
import { useSyncExternalStore } from "react";

function shouldHideAuthFooter(): boolean {
  if (typeof document === "undefined") return false;
  if (detectNativePlatformSync()) return true;
  return document.documentElement.hasAttribute("data-auth-welcome");
}

function shouldHideAuthSubstrate(): boolean {
  if (typeof document === "undefined") return false;
  // Native auth screens use a flat canvas (no wallpaper glow) like sign-in / create-account.
  if (detectNativePlatformSync()) return true;
  if (document.documentElement.hasAttribute("data-auth-native")) return false;
  return document.documentElement.hasAttribute("data-auth-welcome");
}

function subscribeAuthChrome(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-auth-welcome", "data-auth-native", "data-native"],
  });
  return () => observer.disconnect();
}

function useHideAuthFooter(): boolean {
  return useSyncExternalStore(subscribeAuthChrome, shouldHideAuthFooter, () => false);
}

function useHideAuthSubstrate(): boolean {
  return useSyncExternalStore(subscribeAuthChrome, shouldHideAuthSubstrate, () => false);
}

function useAuthWelcomeActive(): boolean {
  return useSyncExternalStore(
    subscribeAuthChrome,
    () => typeof document !== "undefined" && document.documentElement.hasAttribute("data-auth-welcome"),
    () => false,
  );
}

function useAuthNativeActive(): boolean {
  return useSyncExternalStore(
    subscribeAuthChrome,
    () =>
      typeof document !== "undefined" &&
      (document.documentElement.hasAttribute("data-auth-native") ||
        document.documentElement.hasAttribute("data-native")),
    () => false,
  );
}

export function AuthLayoutHomeMark() {
  const active = useAuthWelcomeActive();
  const isNative = useAuthNativeActive();
  if (!active || isNative) return null;
  return (
    <Link
      href="/"
      data-attr="auth-home-logo"
      aria-label="PropLane home"
      className="auth-layout-home-mark absolute left-0 top-0 z-30 p-4 pl-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <AxisLogoMark size="compact" />
    </Link>
  );
}

export function AuthLayoutSubstrate() {
  const hidden = useHideAuthSubstrate();
  if (hidden) return null;
  return <ChromeSubstrate variant="full" />;
}

/**
 * The public site's wavy atmosphere behind every auth screen. The native shells
 * keep their flat canvas (no wallpaper), exactly like the substrate.
 */
export function AuthLayoutBackdrop() {
  const isNative = useAuthNativeActive();
  if (isNative) return null;
  return <SiteBackdrop />;
}

export function AuthLayoutFooter() {
  const hidden = useHideAuthFooter();
  if (hidden) return null;
  return (
    <div className="auth-layout-footer">
      <PublicFooter compact />
    </div>
  );
}
