import { afterEach, describe, expect, it, vi } from "vitest";
import { appendNativeOAuthBridgeParam } from "@/lib/auth/native-oauth-bridge";
import {
  resolveOAuthCallbackRedirectUrl,
  NATIVE_OAUTH_CALLBACK_URL,
} from "@/lib/auth/native-oauth-callback";

/** Stub a native shell (no Capacitor global) tagged via the `data-native` attribute. */
function stubNativeShell(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    documentElement: {
      hasAttribute: (name: string) => name === "data-native",
    },
  });
}

/**
 * Stub the real Capacitor runtime shape: the shell injects `window.Capacitor`, which is what
 * the redirect resolver reads (it must not import `@capacitor/core` — this module is in the
 * server route handlers' import graph).
 */
function stubCapacitorShell(platform: "ios" | "android", webAuthSession: boolean): void {
  vi.stubGlobal("window", {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      isPluginAvailable: (name: string) => webAuthSession && name === "WebAuthSession",
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      hasAttribute: (name: string) => name === "data-native",
    },
  });
}

describe("resolveOAuthCallbackRedirectUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // iOS ASWebAuthenticationSession gets the app custom scheme DIRECTLY as redirect_to. The
  // session's callbackURLScheme intercepts Supabase's 302 to it and dismisses the sheet with
  // no HTML page and no JavaScript. Both Supabase projects allowlist
  // space.proplane.app://auth/callback(/**), so redirect_to is honored (not dropped to the
  // Site URL). Android keeps the HTTPS bridge.
  it("returns the custom scheme directly on iOS when WebAuthSession is linked", () => {
    stubCapacitorShell("ios", true);
    expect(resolveOAuthCallbackRedirectUrl("https://prop-lane.space")).toBe(
      NATIVE_OAUTH_CALLBACK_URL,
    );
    expect(
      resolveOAuthCallbackRedirectUrl("https://prop-lane.space", "/auth/callback/partner-pricing"),
    ).toBe("space.proplane.app://auth/callback/partner-pricing");
  });

  it("keeps the custom scheme on iOS even when the isPluginAvailable probe says otherwise", () => {
    // This is the OTHER half of the single gate: `resolveOAuthCallbackRedirectUrl` picks
    // `redirect_to` and `openOAuthUrl` picks the transport, and they must never disagree — a
    // https `redirect_to` with an ASWebAuthenticationSession transport means the sheet never
    // sees its callback scheme and the sign-in hangs.
    //
    // It used to fall back to the HTTPS bridge when the probe said the plugin was missing, on
    // the reasoning that OAuth could not start anyway so the value was moot. It is no longer
    // moot: iOS always attempts ASWebAuthenticationSession now, because that probe answers
    // false for "not registered yet" too and acting on it dead-ended sign-in for App Review.
    stubCapacitorShell("ios", false);
    expect(resolveOAuthCallbackRedirectUrl("https://prop-lane.space")).toBe(
      "space.proplane.app://auth/callback",
    );
    expect(
      resolveOAuthCallbackRedirectUrl("https://prop-lane.space", "/auth/callback/partner-pricing"),
    ).toBe("space.proplane.app://auth/callback/partner-pricing");
  });

  // Load-bearing invariant: Android MUST NOT move onto the custom scheme. It reports
  // WebAuthSession as available in some shells, so the platform check has to gate first.
  it("keeps the HTTPS bridge on a real Android Capacitor shell even with WebAuthSession available", () => {
    stubCapacitorShell("android", true);
    expect(resolveOAuthCallbackRedirectUrl("https://prop-lane.space")).toBe(
      appendNativeOAuthBridgeParam("https://prop-lane.space/auth/callback"),
    );
    expect(
      resolveOAuthCallbackRedirectUrl("https://prop-lane.space", "/auth/callback/partner-pricing"),
    ).toBe(appendNativeOAuthBridgeParam("https://prop-lane.space/auth/callback/partner-pricing"));
  });

  it("returns https callback with native_bridge for a data-native shell of unknown platform", () => {
    stubNativeShell();
    expect(resolveOAuthCallbackRedirectUrl("http://192.168.5.121:3000")).toBe(
      appendNativeOAuthBridgeParam("http://192.168.5.121:3000/auth/callback"),
    );
    expect(resolveOAuthCallbackRedirectUrl("http://localhost:3000")).toBe(
      appendNativeOAuthBridgeParam("http://localhost:3000/auth/callback"),
    );
  });

  it("maps a fixed callback path onto https with native_bridge on an unknown-platform shell", () => {
    stubNativeShell();
    expect(
      resolveOAuthCallbackRedirectUrl("http://192.168.5.121:3000", "/auth/callback/partner-pricing"),
    ).toBe(
      appendNativeOAuthBridgeParam("http://192.168.5.121:3000/auth/callback/partner-pricing"),
    );
  });

  it("returns https callback with native_bridge for an unknown-platform shell (https origin)", () => {
    stubNativeShell();
    expect(resolveOAuthCallbackRedirectUrl("https://prop-lane.space")).toBe(
      appendNativeOAuthBridgeParam("https://prop-lane.space/auth/callback"),
    );
    expect(resolveOAuthCallbackRedirectUrl("https://www.axis-seattle-housing.com")).toBe(
      appendNativeOAuthBridgeParam("https://www.axis-seattle-housing.com/auth/callback"),
    );
  });

  it("uses the bare same-origin callback on the web (non-native)", () => {
    expect(resolveOAuthCallbackRedirectUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/auth/callback",
    );
  });
});
