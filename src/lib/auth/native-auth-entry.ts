import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { isKnownProductionWebHost } from "@/lib/app-url";
import {
  NATIVE_AUTH_LEGACY_ENTRY_PATH,
  NATIVE_AUTH_WEB_ENTRY_PATH,
  NATIVE_AUTH_WELCOME_PATH,
  NATIVE_MANAGER_PLAN_PATH,
  NATIVE_SHELL_ENTRY_PATH,
  nativeShellEntryPath,
} from "@/lib/auth/native-shell-entry";

export {
  NATIVE_AUTH_LEGACY_ENTRY_PATH,
  NATIVE_AUTH_WEB_ENTRY_PATH,
  NATIVE_AUTH_WELCOME_PATH,
  NATIVE_MANAGER_PLAN_PATH,
  NATIVE_SHELL_ENTRY_PATH,
  nativeShellEntryPath,
};

import { mapPostOAuthPathForNative } from "@/lib/auth/post-oauth-routing";

/** @deprecated Use nativeShellEntryPath — kept for capacitor.config import stability. */
export function nativeAuthEntryPathFromServerBase(_serverBase?: string): string {
  return nativeShellEntryPath();
}

/**
 * In-browser: native shell → /auth/sign-in (welcome UI); website → sign-in form.
 */
export function nativeAuthEntryPathClient(): string {
  if (typeof window === "undefined") return NATIVE_SHELL_ENTRY_PATH;
  const override = process.env.NEXT_PUBLIC_NATIVE_AUTH_ENTRY?.trim();
  if (override) return override.startsWith("/") ? override : `/${override}`;
  if (detectNativePlatformSync()) return NATIVE_SHELL_ENTRY_PATH;
  return NATIVE_AUTH_WEB_ENTRY_PATH;
}

export function nativeAwarePath(path: string): string {
  if (typeof window === "undefined") return path;
  const isNative =
    detectNativePlatformSync() ||
    (typeof document !== "undefined" && document.documentElement.hasAttribute("data-native"));
  if (!isNative) return path;
  return mapPostOAuthPathForNative(path);
}

/** @deprecated Use nativeShellEntryPath / nativeAuthEntryPathClient. */
export function nativeAuthEntryPathForHost(_hostname: string): string {
  return nativeShellEntryPath();
}

export function isProductionAxisHost(hostname: string): boolean {
  return isKnownProductionWebHost(hostname);
}
