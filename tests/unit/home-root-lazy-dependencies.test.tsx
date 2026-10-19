// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: null as "ios" | null, pathname: "/", detect: vi.fn(), tag: vi.fn(), info: vi.fn(),
  listings: vi.fn(), browser: vi.fn(), session: vi.fn(), redirect: vi.fn(),
  push: vi.fn(), launch: vi.fn(), zoom: vi.fn(), unzoom: vi.fn(), marker: vi.fn(),
  openUrl: vi.fn(), inOAuth: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  reset: vi.fn(), modalLoaded: vi.fn(), confirmLoaded: vi.fn(), listingsLoaded: vi.fn(), browserLoaded: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => mocks.platform, tagHtmlNativePlatform: mocks.tag }));
vi.mock("@/lib/native/push-client", () => ({ getNativeInfo: mocks.info, registerPushIfGranted: mocks.push, resendCachedToken: vi.fn() }));
vi.mock("@/lib/demo-property-pipeline", () => { mocks.listingsLoaded(); return { loadPublicExtraListingsFromServer: mocks.listings }; });
vi.mock("@/lib/supabase/browser", () => { mocks.browserLoaded(); return { createSupabaseBrowserClient: mocks.browser }; });
vi.mock("@/lib/supabase/safe-browser-session", () => ({ safeBrowserGetSession: mocks.session }));
vi.mock("@/lib/auth/native-welcome-redirect", () => ({ redirectNativeFromMarketing: mocks.redirect }));
vi.mock("@/lib/native/open-url", () => ({ handleNativeOAuthReturnUrl: mocks.openUrl, isNativeOAuthInProgress: mocks.inOAuth }));
vi.mock("@/lib/native/disable-native-zoom", () => ({ installNativeZoomLock: mocks.zoom }));
vi.mock("@/lib/native/app-review", () => ({ recordAppLaunch: mocks.launch }));
vi.mock("@/lib/native/native-session-marker", () => ({ markNativeSession: mocks.marker }));
vi.mock("@/lib/dev/reset-epoch", () => ({ applyDevResetEpoch: mocks.reset }));
vi.mock("@capacitor/splash-screen", () => ({ SplashScreen: { hide: vi.fn() } }));
vi.mock("@capacitor/status-bar", () => ({ StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn() }, Style: { Dark: "dark" } }));
vi.mock("@capacitor/app", () => ({ App: { getLaunchUrl: async () => ({}), addListener: mocks.addListener } }));
vi.mock("@/components/ui/modal", () => {
  mocks.modalLoaded();
  return { Modal: ({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) => <div role="dialog" aria-label={title}>{children}<button onClick={onClose}>Dismiss message</button></div> };
});
vi.mock("@/components/portal/confirm-delete-modal", () => {
  mocks.confirmLoaded();
  return { ConfirmDeleteModal: ({ description, onConfirm, onClose }: { description: ReactNode; onConfirm: () => void; onClose: () => void }) => <div role="dialog" aria-label="Confirmation">{description}<button onClick={onConfirm}>Confirm</button><button onClick={onClose}>Cancel</button></div> };
});

import { AppUiProvider, useAppUi } from "@/components/providers/app-ui-provider";
import { NativeBridge } from "@/components/native/native-bridge";
import { NativeAppGate } from "@/components/native/native-app-gate";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_DEV_RESET_EPOCH", "");
  mocks.platform = null; mocks.pathname = "/";
  mocks.info.mockResolvedValue({ isNative: false, platform: "web" });
  mocks.zoom.mockReturnValue(mocks.unzoom);
  mocks.listings.mockResolvedValue(undefined);
  mocks.inOAuth.mockReturnValue(false);
  mocks.session.mockResolvedValue({ session: null });
  mocks.browser.mockReturnValue({ auth: { getUser: async () => ({ data: { user: null } }) } });
  mocks.redirect.mockImplementation(async (getSession: () => Promise<unknown>) => { await getSession(); return true; });
  mocks.addListener.mockResolvedValue({ remove: mocks.removeListener });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

function Controls({ settled }: { settled: (value: boolean) => void }) {
  const ui = useAppUi();
  return <><button onClick={() => ui.openModal({ title: "Message", body: "Hello" })}>Open message</button>
    <button onClick={() => void ui.confirm({ description: "Delete this sample?" }).then(settled)}>Ask confirmation</button></>;
}

describe("root features load only when needed", () => {
  it("does not import modal, portal data, or auth implementations on an ordinary web mount", async () => {
    render(<AppUiProvider><NativeBridge /><NativeAppGate><span>Public page</span></NativeAppGate></AppUiProvider>);
    await waitFor(() => expect(mocks.info).toHaveBeenCalled());
    expect(screen.getByText("Public page")).toBeTruthy();
    expect(mocks.modalLoaded).not.toHaveBeenCalled();
    expect(mocks.confirmLoaded).not.toHaveBeenCalled();
    expect(mocks.listingsLoaded).not.toHaveBeenCalled();
    expect(mocks.browserLoaded).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("loads dialogs on demand and preserves confirm/cancel promise outcomes", async () => {
    const settled = vi.fn();
    render(<AppUiProvider><Controls settled={settled} /></AppUiProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open message" }));
    await screen.findByRole("dialog", { name: "Message" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask confirmation" }));
    await screen.findByRole("dialog", { name: "Confirmation" }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(settled).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Ask confirmation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(settled).toHaveBeenLastCalledWith(false));
  });

  it("still applies an explicitly configured development reset", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_RESET_EPOCH", "test-epoch");
    render(<AppUiProvider><span>Page</span></AppUiProvider>);
    await waitFor(() => expect(mocks.reset).toHaveBeenCalledOnce());
  });

  it("preserves native startup, portal refresh registration, and listener cleanup", async () => {
    mocks.platform = "ios";
    const view = render(<NativeBridge />);
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    expect(mocks.tag).toHaveBeenCalledWith("ios");
    expect(mocks.marker).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.listings).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.addListener.mock.calls.map(([event]) => event)).toEqual(["resume", "appUrlOpen"]);
    view.unmount();
    expect(mocks.unzoom).toHaveBeenCalledOnce();
    expect(mocks.removeListener).toHaveBeenCalledTimes(2);
  });

  it("retains asynchronous native detection when the bridge is not installed synchronously", async () => {
    mocks.info.mockResolvedValue({ isNative: true, platform: "ios" });
    render(<NativeBridge />);
    await waitFor(() => expect(mocks.listings).toHaveBeenCalledOnce());
    expect(mocks.tag).toHaveBeenCalledWith("ios");
  });

  it("does not start native work after unmount while detection was pending", async () => {
    let resolve!: (value: { isNative: boolean; platform: string }) => void;
    mocks.info.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<NativeBridge />);
    view.unmount();
    await act(async () => { resolve({ isNative: true, platform: "ios" }); });
    expect(mocks.listings).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("loads auth only for native marketing redirects, leaving allowed native routes alone", async () => {
    mocks.platform = "ios";
    mocks.pathname = "/resident";
    const view = render(<NativeAppGate><span>Portal</span></NativeAppGate>);
    await act(async () => {});
    expect(mocks.browser).not.toHaveBeenCalled();
    mocks.pathname = "/";
    view.rerender(<NativeAppGate><span>Marketing</span></NativeAppGate>);
    await waitFor(() => expect(mocks.session).toHaveBeenCalledOnce());
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(mocks.redirect).toHaveBeenCalledOnce();
  });

  it("keeps heavyweight dependencies out of the static root import graph", () => {
    const expectations = [
      ["src/components/providers/app-ui-provider.tsx", ["@/components/ui/modal", "@/components/portal/confirm-delete-modal", "@/lib/dev/reset-epoch"]],
      ["src/components/native/native-bridge.tsx", ["@/lib/demo-property-pipeline", "@/lib/supabase/browser", "@/lib/native/open-url"]],
      ["src/components/native/native-app-gate.tsx", ["@/lib/supabase/browser", "@/lib/supabase/safe-browser-session"]],
    ] as const;
    for (const [file, dependencies] of expectations) {
      const source = readFileSync(file, "utf8");
      for (const dependency of dependencies) {
        expect(source, `${file}: ${dependency}`).not.toContain(`from "${dependency}"`);
        expect(source).toContain(`import("${dependency}")`);
      }
    }
  });
});
