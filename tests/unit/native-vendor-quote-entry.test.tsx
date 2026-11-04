// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  launch: vi.fn(), oauth: vi.fn(), redirects: vi.fn(),
  listeners: new Map<string, (event: { url?: string }) => unknown>(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/vendor-quote" }));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => "ios", tagHtmlNativePlatform: vi.fn() }));
vi.mock("@/lib/native/disable-native-zoom", () => ({ installNativeZoomLock: () => vi.fn() }));
vi.mock("@/lib/native/native-session-marker", () => ({ markNativeSession: vi.fn() }));
vi.mock("@/lib/native/app-review", () => ({ recordAppLaunch: vi.fn() }));
vi.mock("@/lib/native/push-client", () => ({ getNativeInfo: async () => ({ isNative: true, platform: "ios" }), registerPushIfGranted: vi.fn(), resendCachedToken: vi.fn() }));
vi.mock("@/lib/native/open-url", () => ({ handleNativeOAuthReturnUrl: mocks.oauth, isNativeOAuthInProgress: () => false }));
vi.mock("@/lib/auth/native-welcome-redirect", () => ({ redirectNativeFromMarketing: mocks.redirects }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { getUser: vi.fn() } }) }));
vi.mock("@/lib/demo-property-pipeline", () => ({ loadPublicExtraListingsFromServer: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: {
  getLaunchUrl: mocks.launch,
  addListener: async (name: string, callback: (event: { url?: string }) => unknown) => { mocks.listeners.set(name, callback); return { remove: vi.fn() }; },
} }));
vi.mock("@capacitor/splash-screen", () => ({ SplashScreen: { hide: vi.fn() } }));
vi.mock("@capacitor/status-bar", () => ({ StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn() }, Style: { Dark: "DARK" } }));
import { NativeBridge } from "@/components/native/native-bridge";
import { NativeAppGate } from "@/components/native/native-app-gate";
const url = "https://proplane.ai/vendor-quote?source=email#response=capability-token";
describe("native vendor quote entry", () => {
  let location: Location;
  let navigations: string[];
  beforeEach(() => {
    mocks.launch.mockReset().mockResolvedValue(undefined); mocks.oauth.mockReset().mockResolvedValue(false);
    mocks.redirects.mockReset().mockResolvedValue(undefined); mocks.listeners.clear();
    vi.stubGlobal("crypto", webcrypto); sessionStorage.clear();
    location = window.location; navigations = [];
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: {
      pathname: "/vendor-quote", search: "", hash: "", origin: "https://proplane.ai",
      assign: (target: string) => navigations.push(target), replace: vi.fn(),
    } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(window, "location", { configurable: true, writable: true, value: location }); });
  it("preserves the capability fragment on a cold app launch", async () => {
    mocks.launch.mockResolvedValue({ url }); render(<NativeBridge />);
    await waitFor(() => expect(navigations).toEqual(["/vendor-quote?source=email#response=capability-token"]));
  });
  it("preserves the fragment when the running app receives a quote link", async () => {
    render(<NativeBridge />); await waitFor(() => expect(mocks.listeners.has("appUrlOpen")).toBe(true));
    await mocks.listeners.get("appUrlOpen")!({ url });
    await waitFor(() => expect(navigations).toEqual(["/vendor-quote?source=email#response=capability-token"]));
  });
  it("keeps the public quote page available without redirecting to auth", async () => {
    render(<NativeAppGate><div>Service quote</div></NativeAppGate>);
    await waitFor(() => expect(screen.getByText("Service quote")).toBeVisible());
    expect(mocks.redirects).not.toHaveBeenCalled();
  });
  it("does not replay a persistent launch after fragment removal or later navigation", async () => {
    mocks.launch.mockResolvedValue({ url });
    const first = render(<NativeBridge />);
    await waitFor(() => expect(navigations).toHaveLength(1)); first.unmount(); mocks.listeners.clear();
    Object.assign(window.location, { pathname: "/vendor-quote", search: "?source=email", hash: "" });
    const quote = render(<NativeBridge />);
    await waitFor(() => expect(mocks.listeners.has("appUrlOpen")).toBe(true));
    expect(navigations).toHaveLength(1); quote.unmount(); mocks.listeners.clear();
    Object.assign(window.location, { pathname: "/vendor/services", search: "", hash: "" });
    render(<NativeBridge />);
    await waitFor(() => expect(mocks.listeners.has("appUrlOpen")).toBe(true));
    expect(navigations).toHaveLength(1);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("capability-token");
    await mocks.listeners.get("appUrlOpen")!({ url: url.replace("capability-token", "new-capability") });
    await waitFor(() => expect(navigations).toHaveLength(2));
  });
  it("does not reload an already visible target and still installs live listeners", async () => {
    mocks.launch.mockResolvedValue({ url });
    Object.assign(window.location, { search: "?source=email", hash: "#response=capability-token" });
    render(<NativeBridge />);
    await waitFor(() => expect(mocks.listeners.has("appUrlOpen")).toBe(true));
    await mocks.listeners.get("appUrlOpen")!({ url });
    await waitFor(() => expect(mocks.oauth).toHaveBeenCalledTimes(2));
    expect(navigations).toEqual([]);
  });

  it("keeps live links available when cold-launch replay memory is unavailable", async () => {
    mocks.launch.mockResolvedValue({ url });
    const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage blocked"); });
    try {
      render(<NativeBridge />);
      await waitFor(() => expect(mocks.listeners.has("appUrlOpen")).toBe(true));
      expect(navigations).toEqual([]);
      await mocks.listeners.get("appUrlOpen")!({ url });
      expect(navigations).toEqual(["/vendor-quote?source=email#response=capability-token"]);
    } finally { denied.mockRestore(); }
  });

});
