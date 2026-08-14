// @vitest-environment jsdom
//
// App Review rejected build 1.0 (69) under Guideline 2.1 App Completeness:
// "We received an error message after we attempted to log in." (iPad Air M4, iPadOS 26.6.)
//
// The iOS OAuth transport used to be gated on `Capacitor.isPluginAvailable("WebAuthSession")`.
// `WebAuthSessionPlugin` is attached at RUNTIME by `BridgeViewController` via
// `registerPluginInstance`, so a false answer there means "not registered yet" just as often as
// "not in this binary" — and the false answer dead-ended sign-in with
// "Google sign-in needs the latest version of the PropLane app", shown to someone who had just
// installed the latest version.
//
// iOS therefore now implies ASWebAuthenticationSession, and a genuinely missing plugin is
// detected where it can actually be told apart: the `authenticate()` rejection.
import { afterEach, describe, expect, it } from "vitest";

function stubIosShell(isPluginAvailable: boolean): void {
  (window as unknown as { Capacitor: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: () => isPluginAvailable,
  };
  document.documentElement.setAttribute("data-native", "ios");
}

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  document.documentElement.removeAttribute("data-native");
});

describe("iOS OAuth transport gate", () => {
  it("does NOT depend on the isPluginAvailable probe", async () => {
    const { usesIosAsWebAuthenticationSession } = await import("@/lib/native/ios-oauth");
    // The rejection case: the probe says the plugin is missing while it is in fact registered.
    // Trusting it is what dead-ended sign-in for App Review.
    stubIosShell(false);
    expect(usesIosAsWebAuthenticationSession()).toBe(true);
  });

  it("still resolves true when the probe agrees", async () => {
    const { usesIosAsWebAuthenticationSession } = await import("@/lib/native/ios-oauth");
    stubIosShell(true);
    expect(usesIosAsWebAuthenticationSession()).toBe(true);
  });

  it("is false off iOS, so the redirect scheme and the transport cannot disagree", async () => {
    const { usesIosAsWebAuthenticationSession } = await import("@/lib/native/ios-oauth");
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: () => true,
    };
    expect(usesIosAsWebAuthenticationSession()).toBe(false);

    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    expect(usesIosAsWebAuthenticationSession()).toBe(false);
  });
});

describe("web fallback rejection", () => {
  it("carries UNIMPLEMENTED so the failure renders in place instead of navigating", async () => {
    const { WebAuthSessionWeb } = await import("@/lib/native/web-auth-session.web");
    await expect(
      new WebAuthSessionWeb().authenticate({ url: "https://example.test", callbackScheme: "proplane" }),
    ).rejects.toMatchObject({ code: "UNIMPLEMENTED" });
  });
});
