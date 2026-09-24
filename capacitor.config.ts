import type { CapacitorConfig } from "@capacitor/cli";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_APP_ORIGIN } from "./src/lib/app-url";
import { nativeShellEntryPath } from "./src/lib/auth/native-shell-entry";

const CAP_DEV_SERVER_MARKER = join(process.cwd(), ".cap-dev-server");

/** Production WebView origin — must match PRODUCTION_APP_ORIGIN (proplane.ai). */
export const CAPACITOR_PRODUCTION_SERVER_ORIGIN = PRODUCTION_APP_ORIGIN;

/**
 * Hosts that stay inside the Capacitor WebView.
 * Canonical + redirect sources (prop-lane 308s to proplane.ai) + legacy Axis.
 * Omitted hosts open in the system browser — and a cross-host 308 to an omitted
 * host leaves the splash stuck (black screen).
 */
export const CAPACITOR_ALLOW_NAVIGATION_HOSTS = [
  "proplane.ai",
  "www.proplane.ai",
  "prop-lane.space",
  "www.prop-lane.space",
  // Legacy hosts kept so already-installed shells (and their deep links) keep working.
  "www.axis-seattle-housing.com",
  "axis-seattle-housing.com",
  "localhost",
  "*.supabase.co",
  "*.supabase.in",
  "accounts.google.com",
  "*.google.com",
  "js.stripe.com",
  "checkout.stripe.com",
  "connect.stripe.com",
  "*.stripe.com",
] as const;

function readServerBase(): string {
  const fromEnv = process.env.CAP_SERVER_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    if (existsSync(CAP_DEV_SERVER_MARKER)) {
      const persisted = readFileSync(CAP_DEV_SERVER_MARKER, "utf8").trim();
      if (persisted) return persisted.replace(/\/$/, "");
    }
  } catch {
    /* ignore */
  }
  return CAPACITOR_PRODUCTION_SERVER_ORIGIN;
}

/**
 * Capacitor native shell — opens /auth/sign-in (welcome role picker on device).
 * Local dev: npm run cap:dev (LAN IP for physical iPhone).
 * `cap run ios` re-syncs from this file — dev URL persists via `.cap-dev-server`
 * written by cap:dev until `npm run cap:prod`.
 */
const serverBase = readServerBase();
const nativeEntryPath = nativeShellEntryPath();
const nativeAppUrl = `${serverBase}${nativeEntryPath}`;

function allowNavigationHosts(): string[] {
  // Widen off the `as const` tuple so a LAN/dev hostname (plain string) can be
  // compared and prepended — Array.prototype.includes otherwise rejects it.
  const hosts: string[] = [...CAPACITOR_ALLOW_NAVIGATION_HOSTS];
  try {
    const devHost = new URL(serverBase).hostname;
    if (devHost && !hosts.includes(devHost)) hosts.unshift(devHost);
  } catch {
    /* ignore */
  }
  return hosts;
}

const config: CapacitorConfig = {
  appId: "space.proplane.app",
  appName: "PropLane",
  // Capacitor requires a webDir with an index.html even in hosted mode.
  // Ours doubles as the branded offline fallback screen.
  webDir: "native-shell",
  server: {
    url: nativeAppUrl,
    // Needed only when pointing at an http:// dev server (iOS ATS / Android cleartext).
    cleartext: serverBase.startsWith("http://"),
    // Origins that stay inside the WebView; anything else opens the system browser.
    allowNavigation: allowNavigationHosts(),
  },
  ios: {
    // Full-bleed WebView; safe areas come from viewport-fit=cover + CSS env(safe-area-inset-*).
    contentInset: "never",
    backgroundColor: "#080b14",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: "#080b14",
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
