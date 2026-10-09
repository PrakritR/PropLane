// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const refreshSession = vi.fn();
const signOut = vi.fn();
const onAuthStateChange = vi.fn();
const client = { auth: { getSession, refreshSession, signOut, onAuthStateChange } };
const replace = vi.fn();

vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => null }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => client }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties",
  useRouter: () => ({ replace }),
}));
vi.mock("posthog-js", () => ({ default: { identify: vi.fn() } }));

function authError(message: string, extra: { code?: string; status?: number } = {}) {
  return Object.assign(new Error(message), extra);
}

const liveSession = { user: { id: "viewer-1", email: "v@example.com" }, expires_at: Math.floor(Date.now() / 1000) + 3600 };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  signOut.mockResolvedValue({ error: null });
  refreshSession.mockResolvedValue({ error: null });
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  window.history.replaceState({}, "", "/portal/properties");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePortalSession + PortalClientSessionGuard on a flaky resume", () => {
  it("a transient failure keeps the session pending, keeps cookies, and never redirects; the retry restores it", async () => {
    getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    const { usePortalSession } = await import("@/hooks/use-portal-session");
    const { PortalClientSessionGuard } = await import("@/components/portal/portal-client-session-guard");

    const { result } = renderHook(() => usePortalSession());
    render(<PortalClientSessionGuard />);

    // Run the whole in-hook backoff (1s+2s+4s+8s) without a verdict.
    for (let i = 0; i < 6; i += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(8000)));
    expect(result.current.ready).toBe(false);
    expect(result.current.userId).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    // Connectivity returns: the deferred retry resolves the real session.
    getSession.mockResolvedValue({ data: { session: liveSession }, error: null });
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    expect(result.current).toMatchObject({ ready: true, userId: "viewer-1" });
    expect(replace).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a definitively stale refresh token clears the local session and sends the visitor to sign-in", async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: authError("Invalid Refresh Token: Refresh Token Not Found", { code: "refresh_token_not_found", status: 400 }),
    });
    const { PortalClientSessionGuard } = await import("@/components/portal/portal-client-session-guard");
    render(<PortalClientSessionGuard />);

    await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain("/auth/sign-in?next=");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("an empty INITIAL_SESSION event is not an answer, but an explicit SIGNED_OUT is", async () => {
    getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    const { usePortalSession } = await import("@/hooks/use-portal-session");
    const { result } = renderHook(() => usePortalSession());
    const listener = onAuthStateChange.mock.calls[0][0] as (event: string, session: unknown) => void;

    act(() => listener("INITIAL_SESSION", null));
    expect(result.current.ready).toBe(false);

    act(() => listener("SIGNED_OUT", null));
    expect(result.current).toMatchObject({ ready: true, userId: null });
  });
});

describe("keepalive refresh retries a transient failure and keeps the cookies", () => {
  it("retries a failed refresh, and only a stale token clears the session", async () => {
    const stale = { user: { id: "viewer-1" }, expires_at: Math.floor(Date.now() / 1000) + 30 };
    getSession.mockResolvedValue({ data: { session: stale }, error: null });
    refreshSession
      .mockResolvedValueOnce({ error: authError("fetch failed", { status: 503 }) })
      .mockResolvedValueOnce({ error: authError("Invalid Refresh Token: Already Used", { code: "refresh_token_already_used" }) })
      .mockResolvedValueOnce({ error: null });
    const { refreshPortalSession } = await import("@/components/portal/portal-session-keepalive");

    const pending = refreshPortalSession([5, 5, 5]);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(refreshSession).toHaveBeenCalledTimes(3);
    expect(signOut).not.toHaveBeenCalled();

    refreshSession.mockReset();
    refreshSession.mockResolvedValue({ error: authError("Invalid Refresh Token: Refresh Token Not Found", { code: "refresh_token_not_found" }) });
    await refreshPortalSession([5]);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
