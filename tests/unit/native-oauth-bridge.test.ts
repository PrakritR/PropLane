import { describe, expect, it } from "vitest";
import {
  appendNativeOAuthBridgeParam,
  httpsCallbackToNativeSchemeUrl,
  httpsCallbackWithoutBridgeParam,
  maybeNativeOAuthBridgeResponse,
  nativeOAuthBridgeResponse,
  NATIVE_OAUTH_BRIDGE_PARAM,
  shouldRenderNativeOAuthBridge,
} from "@/lib/auth/native-oauth-bridge";
import { NATIVE_OAUTH_CALLBACK_URL } from "@/lib/auth/native-oauth-callback";
import { NextRequest } from "next/server";

describe("native OAuth bridge", () => {
  it("appends the bridge flag to https callbacks", () => {
    const url = appendNativeOAuthBridgeParam("https://www.axis-seattle-housing.com/auth/callback");
    expect(url).toContain(`${NATIVE_OAUTH_BRIDGE_PARAM}=1`);
    expect(url.startsWith("https://www.axis-seattle-housing.com/auth/callback?")).toBe(true);
  });

  it("maps https callbacks to the app custom scheme without the bridge flag", () => {
    const https = new URL(
      "https://www.axis-seattle-housing.com/auth/callback?native_bridge=1&code=abc123",
    );
    expect(httpsCallbackToNativeSchemeUrl(https)).toBe(
      `${NATIVE_OAUTH_CALLBACK_URL}?code=abc123`,
    );
  });

  it("maps nested callback paths to the custom scheme", () => {
    const https = new URL(
      "https://www.axis-seattle-housing.com/auth/callback/partner-pricing?native_bridge=1&code=abc",
    );
    expect(httpsCallbackToNativeSchemeUrl(https)).toBe(
      "space.proplane.app://auth/callback/partner-pricing?code=abc",
    );
  });

  it("skips bridge HTML inside the Capacitor WebView so the code is exchanged", () => {
    const req = new NextRequest(
      "https://www.axis-seattle-housing.com/auth/callback?native_bridge=1&code=abc123",
      { headers: { "user-agent": "Mozilla/5.0 Capacitor iOS" } },
    );
    expect(shouldRenderNativeOAuthBridge(req)).toBe(false);
  });

  it("renders bridge HTML for system-browser OAuth returns", () => {
    const req = new NextRequest(
      "https://www.axis-seattle-housing.com/auth/callback?native_bridge=1&code=abc123",
      { headers: { "user-agent": "Mozilla/5.0 Mobile Safari" } },
    );
    expect(shouldRenderNativeOAuthBridge(req)).toBe(true);
  });

  it("does not treat an unknown native_bridge value as a bridge", () => {
    const req = new NextRequest(
      "https://prop-lane.space/auth/callback?native_bridge=bogus&code=abc123",
      { headers: { "user-agent": "Mozilla/5.0 Mobile Safari" } },
    );
    expect(shouldRenderNativeOAuthBridge(req)).toBe(false);
  });

  it("strips native_bridge from the https web fallback URL", () => {
    const https = new URL(
      "https://www.axis-seattle-housing.com/auth/callback?native_bridge=1&code=abc123",
    );
    expect(httpsCallbackWithoutBridgeParam(https)).toBe(
      "https://www.axis-seattle-housing.com/auth/callback?code=abc123",
    );
  });

  it("returns HTML (not a redirect) with scheme link, web fallback, and visible anchors", async () => {
    const callbackUrl = new URL(
      "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
    );
    const response = nativeOAuthBridgeResponse(callbackUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(`${NATIVE_OAUTH_CALLBACK_URL}?code=abc123`);
    expect(html).toContain("https://prop-lane.space/auth/callback?code=abc123");
    expect(html).not.toContain("native_bridge");
    expect(html).toContain("Open PropLane");
    expect(html).toContain("Continue in your browser");
    expect(html).toContain('id="open-app"');
    expect(html).toContain('id="continue-browser"');
    expect(html).toContain("visibilitychange");
    expect(html).toContain("1500");
  });

  // Fix 3 (defense in depth for an OLDER iOS binary that still reaches the HTML bridge): the
  // ASWebAuthenticationSession / SFSafariViewController sheet only dismisses on a navigation
  // matching the custom callback scheme, and a synthesized anchor click with no user gesture
  // is unreliable inside it. So the iOS branch performs a TOP-LEVEL navigation to the scheme
  // immediately, and never the timed web fallback (which would dump the portal into the sheet).
  it("deep-links top-level and omits the timed web fallback for iOS", async () => {
    const callbackUrl = new URL(
      "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
    );
    const response = nativeOAuthBridgeResponse(callbackUrl, { isIos: true });
    const html = await response.text();

    // Deep-link attempt + manual continue link stay; the timed fallback that would
    // dump the portal into in-app Safari must be gated off.
    expect(html).toContain("Open PropLane");
    expect(html).toContain("Continue in your browser");
    expect(html).toContain("var isIos = true");
    expect(html).toContain("window.location.replace(schemeTarget)");
    expect(html).toContain("if (false)");
    expect(html).not.toContain("if (true)");
  });

  it("keeps the anchor-click deep link and timed web fallback for Android (Chrome Custom Tab)", async () => {
    const callbackUrl = new URL(
      "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
    );
    const response = nativeOAuthBridgeResponse(callbackUrl, { isIos: false });
    const html = await response.text();

    expect(html).toContain("var isIos = false");
    expect(html).toContain('getElementById("open-app")');
    expect(html).toContain("if (true)");
    expect(html).toContain("1500");
  });

  it("routes an Android native_bridge=1 request to the HTML bridge, never a redirect", async () => {
    const req = new NextRequest(
      "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
      {
        headers: {
          "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari",
        },
      },
    );
    const response = maybeNativeOAuthBridgeResponse(req);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("location")).toBeNull();
    expect(await response!.text()).toContain("Open PropLane");
  });

  it("gates the auto-navigation off when the request comes from an iOS user agent", async () => {
    const req = new NextRequest(
      "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
      { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari" } },
    );
    const response = maybeNativeOAuthBridgeResponse(req);
    expect(response).not.toBeNull();
    const html = await response!.text();
    expect(html).toContain("if (false)");
  });

  it("does not render bridge HTML inside the Capacitor WebView", () => {
    const req = new NextRequest(
      "https://www.axis-seattle-housing.com/auth/callback?native_bridge=1&code=abc123",
      { headers: { "user-agent": "Mozilla/5.0 Capacitor iOS" } },
    );
    expect(shouldRenderNativeOAuthBridge(req)).toBe(false);
  });

  // Fix 3 (defense in depth for an OLDER iOS binary that still reaches the HTML bridge): the
  // ASWebAuthenticationSession / SFSafariViewController sheet only dismisses on a navigation
  // matching the custom callback scheme, and a synthesized anchor click with no user gesture
  // is unreliable inside it. So the iOS branch performs a TOP-LEVEL navigation to the scheme
  // immediately, and never the timed web fallback (which would dump the portal into the sheet).
  describe("iOS bridge hardening (fix 3)", () => {
    it("does a top-level window.location navigation to the scheme on iOS", async () => {
      const callbackUrl = new URL(
        "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
      );
      const html = await nativeOAuthBridgeResponse(callbackUrl, { isIos: true }).text();
      expect(html).toContain("var isIos = true");
      expect(html).toContain("window.location.replace(schemeTarget)");
      // Timed web fallback stays gated off on iOS.
      expect(html).toContain("if (false)");
    });

    it("keeps the anchor-click deep link and timed fallback for Android", async () => {
      const callbackUrl = new URL(
        "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
      );
      const html = await nativeOAuthBridgeResponse(callbackUrl, { isIos: false }).text();
      expect(html).toContain("var isIos = false");
      expect(html).toContain('getElementById("open-app")');
      expect(html).toContain("if (true)");
      expect(html).toContain("1500");
    });

    it("routes an Android native_bridge=1 request to the HTML bridge, never a redirect", async () => {
      const req = new NextRequest(
        "https://prop-lane.space/auth/callback?native_bridge=1&code=abc123",
        {
          headers: {
            "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari",
          },
        },
      );
      const response = maybeNativeOAuthBridgeResponse(req);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);
      expect(response!.headers.get("location")).toBeNull();
      expect(await response!.text()).toContain("Open PropLane");
    });
  });
});
