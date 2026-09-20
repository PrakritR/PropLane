// @vitest-environment jsdom
import type { Session } from "@supabase/supabase-js";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  native: vi.fn(),
  addListener: vi.fn(),
}));

let authCallback: ((event: string, session: Session | null) => void) | undefined;

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
      signOut: mocks.signOut,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  }),
}));

vi.mock("@/lib/native/detect-native", () => ({
  detectNativePlatformSync: mocks.native,
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: mocks.addListener },
}));

import { PortalSessionKeepalive } from "@/components/portal/portal-session-keepalive";

const NOW = Date.now();

function session(userId: string, expiresInMs: number, refreshToken = `refresh-${userId}`): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: refreshToken,
    expires_in: Math.floor(expiresInMs / 1000),
    expires_at: Math.floor((NOW + expiresInMs) / 1000),
    token_type: "bearer",
    user: { id: userId } as Session["user"],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("PortalSessionKeepalive", () => {
  beforeEach(() => {
    authCallback = undefined;
    mocks.getSession.mockReset();
    mocks.refreshSession.mockReset();
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.unsubscribe.mockReset();
    mocks.native.mockReset().mockReturnValue(false);
    mocks.addListener.mockReset();
    mocks.onAuthStateChange.mockReset().mockImplementation((callback) => {
      authCallback = callback;
      return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    authCallback?.("SIGNED_OUT", null);
  });

  it("routes a permanent getSession error through the coordinator cleanup", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    render(<PortalSessionKeepalive />);

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("routes a thrown permanent first-read error through the coordinator cleanup", async () => {
    mocks.getSession.mockRejectedValue(
      new Error("Invalid Refresh Token: Refresh Token Not Found"),
    );

    render(<PortalSessionKeepalive />);

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it.each(["returned", "thrown"] as const)(
    "routes a %s permanent second-read error through the coordinator cleanup",
    async (kind) => {
      const current = session("manager-1", 30_000);
      mocks.getSession.mockResolvedValueOnce({ data: { session: current }, error: null });
      if (kind === "returned") {
        mocks.getSession.mockResolvedValueOnce({
          data: { session: null },
          error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
        });
      } else {
        mocks.getSession.mockRejectedValueOnce(
          new Error("Invalid Refresh Token: Refresh Token Not Found"),
        );
      }

      render(<PortalSessionKeepalive />);

      await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
      expect(mocks.refreshSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "429 response",
      makeResult: () =>
        Promise.resolve({
          data: { session: null },
          error: { status: 429, message: "Too many requests" },
        }),
    },
    {
      name: "network rejection",
      makeResult: () => Promise.reject(new TypeError("Failed to fetch")),
    },
  ])("does not invoke application cleanup for a $name", async ({ makeResult }) => {
    const result = makeResult();
    mocks.getSession.mockReturnValueOnce(result);

    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
    await act(async () => {
      await result.catch(() => undefined);
      await Promise.resolve();
    });

    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("uses auth lifecycle events to guard a pending destructive read cleanup", async () => {
    const pending = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string };
    }>();
    mocks.getSession.mockReturnValueOnce(pending.promise);

    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
    expect(authCallback).toBeTypeOf("function");

    authCallback?.("SIGNED_IN", session("resident-1", 60 * 60 * 1000));
    await act(async () => {
      pending.resolve({
        data: { session: null },
        error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
      });
      await pending.promise;
      await Promise.resolve();
    });

    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("coalesces active visibility and native resume signals", async () => {
    let current = session("manager-1", 30_000);
    const pendingRefresh = deferred<{
      data: { session: Session };
      error: null;
    }>();
    let resume: (() => void) | undefined;
    mocks.native.mockReturnValue(true);
    mocks.getSession.mockImplementation(async () => ({ data: { session: current }, error: null }));
    mocks.refreshSession.mockImplementationOnce(async () => {
      const response = await pendingRefresh.promise;
      // The SDK saves renewal and emits TOKEN_REFRESHED before resolving.
      current = response.data.session;
      authCallback?.("TOKEN_REFRESHED", current);
      return response;
    });
    mocks.addListener.mockImplementation(async (_event, callback) => {
      resume = callback;
      return { remove: vi.fn(async () => undefined) };
    });

    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());
    await waitFor(() => expect(resume).toBeTypeOf("function"));

    document.dispatchEvent(new Event("visibilitychange"));
    resume?.();
    await act(async () => {
      pendingRefresh.resolve({
        data: { session: session("manager-1", 60 * 60 * 1000, "rotated") },
        error: null,
      });
      await pendingRefresh.promise;
      await Promise.resolve();
    });

    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();

    const readsAfterRenewal = mocks.getSession.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    resume?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getSession).toHaveBeenCalledTimes(readsAfterRenewal + 2);
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
  });

  it("keeps near-expiry mount work active across INITIAL_SESSION", async () => {
    const current = session("manager-1", 30_000);
    const pendingRead = deferred<{
      data: { session: Session | null };
      error: null;
    }>();
    mocks.getSession
      .mockReturnValueOnce(pendingRead.promise)
      .mockResolvedValue({ data: { session: current }, error: null });
    mocks.refreshSession.mockResolvedValue({
      data: { session: session("manager-1", 60 * 60 * 1000, "rotated") },
      error: null,
    });

    render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
    authCallback?.("INITIAL_SESSION", current);
    await act(async () => {
      pendingRead.resolve({ data: { session: current }, error: null });
      await pendingRead.promise;
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("invalidates pending destructive cleanup when the keepalive unmounts", async () => {
    const current = session("manager-1", 30_000);
    const pendingRefresh = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string };
    }>();
    mocks.getSession.mockResolvedValue({ data: { session: current }, error: null });
    mocks.refreshSession.mockReturnValueOnce(pendingRefresh.promise);

    const view = render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => {
      pendingRefresh.resolve({
        data: { session: null },
        error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
      });
      await pendingRefresh.promise;
      await Promise.resolve();
    });

    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not revive a successful pending first read after unmount", async () => {
    const pendingRead = deferred<{
      data: { session: Session | null };
      error: null;
    }>();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mocks.getSession.mockReturnValueOnce(pendingRead.promise);

    const view = render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => {
      pendingRead.resolve({
        data: { session: session("manager-1", 30_000) },
        error: null,
      });
      await pendingRead.promise;
      await Promise.resolve();
    });

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    setItem.mockRestore();
  });

  it("removes a native listener that finishes registering after unmount", async () => {
    const current = session("manager-1", 60 * 60 * 1000);
    const registration = deferred<{ remove: ReturnType<typeof vi.fn> }>();
    const remove = vi.fn(async () => undefined);
    let resume: (() => void) | undefined;
    mocks.native.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({ data: { session: current }, error: null });
    mocks.addListener.mockImplementation((_event, callback) => {
      resume = callback;
      return registration.promise;
    });

    const view = render(<PortalSessionKeepalive />);
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledOnce());
    view.unmount();
    const readsAtUnmount = mocks.getSession.mock.calls.length;

    await act(async () => {
      registration.resolve({ remove });
      await registration.promise;
      await Promise.resolve();
    });
    expect(remove).toHaveBeenCalledOnce();

    resume?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getSession).toHaveBeenCalledTimes(readsAtUnmount);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});
