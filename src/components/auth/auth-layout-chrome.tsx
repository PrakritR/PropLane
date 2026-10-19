"use client";

import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { PublicFooter } from "@/components/layout/public-footer";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import Link from "next/link";
import { useSyncExternalStore } from "react";

function shouldHideAuthFooter(): boolean {
  if (typeof document === "undefined") return false;
  if (detectNativePlatformSync()) return true;
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
  const isNative = useAuthNativeActive();
  // The split screen carries the mark top-left on every web auth page, not only the welcome ones.
  if (isNative) return null;
  return (
    <Link
      href="/"
      data-attr="auth-home-logo"
      aria-label="PropLane home"
      className="auth-layout-home-mark ps-logo absolute left-0 top-0 z-30"
    >
      <ProPlaneMarkIcon />
      <span>PropLane</span>
    </Link>
  );
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
