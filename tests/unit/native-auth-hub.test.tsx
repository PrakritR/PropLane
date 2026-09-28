// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authState, getSession, waitForOAuthUser } = vi.hoisted(() => ({
  authState: { oauthInProgress: false },
  getSession: vi.fn(),
  waitForOAuthUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: true, platform: "ios" }),
}));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => "ios" }));
vi.mock("@/lib/native/open-url", () => ({
  isNativeOAuthInProgress: () => authState.oauthInProgress,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getSession } }),
}));
vi.mock("@/lib/auth/wait-for-oauth-user", () => ({ waitForOAuthUser }));
vi.mock("@/lib/auth/recover-implicit-auth-hash", () => ({
  recoverImplicitAuthHash: vi.fn().mockResolvedValue({ recovered: false }),
}));

import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderHub() {
  return render(
    <AppUiProvider>
      <NativeAuthHub />
    </AppUiProvider>,
  );
}

describe("NativeAuthHub native session recovery", () => {
  let realLocation: Location;
  let navigations: string[];

  beforeEach(() => {
    authState.oauthInProgress = false;
    getSession.mockReset();
    getSession.mockResolvedValue({ data: { session: null } });
    waitForOAuthUser.mockReset();
    waitForOAuthUser.mockResolvedValue(null);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    navigations = [];
    realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...realLocation,
        replace: (url: string) => void navigations.push(url),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: realLocation,
    });
  });

  it("recovers a marked OAuth return immediately when mounted visible", async () => {
    authState.oauthInProgress = true;
    waitForOAuthUser.mockResolvedValue({ id: "oauth-user" });

    renderHub();

    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    await waitFor(() => expect(navigations).toEqual(["/auth/continue"]));
    expect(waitForOAuthUser).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("coalesces repeated visible events into the active OAuth recovery", async () => {
    authState.oauthInProgress = true;
    const recovery = deferred<null>();
    waitForOAuthUser.mockReturnValue(recovery.promise);

    renderHub();
    await waitFor(() => expect(waitForOAuthUser).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(waitForOAuthUser).toHaveBeenCalledTimes(1);

    await act(async () => recovery.resolve(null));
    expect(navigations).toEqual([]);
  });

  it("cancels active OAuth recovery on unmount", async () => {
    authState.oauthInProgress = true;
    const recovery = deferred<{ id: string } | null>();
    waitForOAuthUser.mockReturnValue(recovery.promise);
    const view = renderHub();

    await waitFor(() => expect(waitForOAuthUser).toHaveBeenCalledTimes(1));
    const signal = waitForOAuthUser.mock.calls[0]?.[1]?.signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);

    await act(async () => recovery.resolve({ id: "late-user" }));
    expect(navigations).toEqual([]);
  });

  it("validates a cached local user before passive routing", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "local-user" } } } });
    waitForOAuthUser.mockResolvedValue({ id: "validated-user" });

    renderHub();

    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    await waitFor(() => expect(navigations).toEqual(["/auth/continue"]));
    expect(waitForOAuthUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attempts: 2, maxWaitMs: 1_200 }),
    );
  });

  it("keeps the credential form usable when a cached local user cannot be validated", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "stale-local-user" } } } });
    const validation = deferred<null>();
    waitForOAuthUser.mockReturnValue(validation.promise);

    renderHub();

    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    expect(navigations).toEqual([]);
    await act(async () => validation.resolve(null));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(navigations).toEqual([]);
    expect(waitForOAuthUser).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText("Password")).toBeEnabled();
  });

  it("shows the credential form when the real bounded session timeout expires", async () => {
    vi.useFakeTimers();
    getSession.mockReturnValue(new Promise(() => undefined));

    renderHub();
    expect(screen.queryByPlaceholderText("Email")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(400));

    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
    expect(navigations).toEqual([]);
  });
});
