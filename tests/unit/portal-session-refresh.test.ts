import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createPortalSessionRefreshCoordinator,
  PORTAL_SESSION_REFRESH_MARGIN_MS,
} from "@/lib/supabase/portal-session-refresh";

const NOW = 1_800_000_000_000;

function session(userId: string, expiresInMs: number): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
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

function harness(initialSession: Session | null) {
  let currentSession = initialSession;
  const getSession = vi.fn(async () => ({ session: currentSession, error: null as unknown }));
  const refreshSession = vi.fn(
    async (): Promise<{ data: { session: Session | null }; error: unknown }> => ({
      data: { session: currentSession },
      error: null,
    }),
  );
  const clearStaleAuth = vi.fn(async () => undefined);
  const markSignedIn = vi.fn();
  const coordinator = createPortalSessionRefreshCoordinator({
    getSession,
    refreshSession,
    clearStaleAuth,
    markSignedIn,
    now: () => NOW,
  });
  return {
    run: coordinator.refresh,
    observeInitialSession: coordinator.observeInitialSession,
    observeAuthLifecycle: coordinator.observeAuthLifecycle,
    invalidate: coordinator.invalidate,
    getSession,
    refreshSession,
    clearStaleAuth,
    markSignedIn,
    setSession: (value: Session | null) => {
      currentSession = value;
    },
  };
}

describe("portal session refresh coordinator", () => {
  it("keeps repeated fresh mounts without explicitly refreshing the session", async () => {
    const test = harness(session("manager-1", 60 * 60 * 1000));

    await expect(Promise.all(Array.from({ length: 30 }, () => test.run()))).resolves.toEqual(
      Array.from({ length: 30 }, () => "not-due"),
    );

    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalledTimes(30);
  });

  it("renews a session that is inside the resume safety margin", async () => {
    const test = harness(session("resident-1", PORTAL_SESSION_REFRESH_MARGIN_MS));

    await expect(test.run()).resolves.toBe("refreshed");

    expect(test.refreshSession).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous visibility and native resume work for one owner", async () => {
    const test = harness(session("manager-1", 30_000));
    const pending = deferred<{ data: { session: Session | null }; error: null }>();
    test.refreshSession.mockReturnValueOnce(pending.promise);

    const visibility = test.run();
    const nativeResume = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    pending.resolve({ data: { session: session("manager-1", 60 * 60 * 1000) }, error: null });

    await expect(Promise.all([visibility, nativeResume])).resolves.toEqual(["refreshed", "refreshed"]);
    expect(test.refreshSession).toHaveBeenCalledOnce();
  });

  it("does not revive a first-read snapshot after concurrent renewal changes its generation", async () => {
    const current = session("manager-1", 30_000);
    const renewed = {
      ...session("manager-1", 60 * 60 * 1000),
      refresh_token: "rotated-by-concurrent-refresh",
    };
    const test = harness(current);
    const pendingRefresh = deferred<{ data: { session: Session | null }; error: null }>();
    test.refreshSession.mockReturnValueOnce(pendingRefresh.promise);

    const first = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    const pendingRead = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pendingRead.promise);
    const overlapping = test.run();
    const signedInBeforeCompletion = test.markSignedIn.mock.calls.length;

    // Queue readSession's continuation first, then the refresh continuation.
    // The helper accepts the old snapshot before the refresh rotates identity;
    // the outer first-read continuation resumes only after that rotation.
    pendingRead.resolve({ session: current, error: null });
    test.setSession(renewed);
    pendingRefresh.resolve({ data: { session: renewed }, error: null });

    await expect(first).resolves.toBe("refreshed");
    await expect(overlapping).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledTimes(3);
    expect(test.refreshSession).toHaveBeenCalledOnce();
    expect(test.markSignedIn).toHaveBeenCalledTimes(signedInBeforeCompletion + 1);
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
    await expect(test.run()).resolves.toBe("not-due");
    expect(test.refreshSession).toHaveBeenCalledOnce();
  });

  it("keeps a near-expiry first read alive across the subscription's initial observation", async () => {
    const current = session("manager-1", 30_000);
    const test = harness(current);
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const refresh = test.run();
    test.observeInitialSession(current);
    pending.resolve({ session: current, error: null });

    await expect(refresh).resolves.toBe("refreshed");
    expect(test.refreshSession).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("does not explicitly refresh when getSession already renewed the session", async () => {
    const stale = session("manager-1", 30_000);
    const renewed = session("manager-1", 60 * 60 * 1000);
    const test = harness(stale);
    test.getSession
      .mockResolvedValueOnce({ session: stale, error: null })
      .mockResolvedValueOnce({ session: renewed, error: null });

    await expect(test.run()).resolves.toBe("not-due");

    expect(test.refreshSession).not.toHaveBeenCalled();
  });

  it("clears local auth for a recognized permanently revoked refresh token", async () => {
    const test = harness(session("manager-1", 30_000));
    test.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(test.run()).resolves.toBe("permanent-failure");

    expect(test.clearStaleAuth).toHaveBeenCalledOnce();
  });

  it("does not add application cleanup after rate limiting", async () => {
    const test = harness(session("manager-1", 30_000));
    test.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: { status: 429, message: "Too many requests" },
    });

    await expect(test.run()).resolves.toBe("transient-failure");

    expect(test.clearStaleAuth).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalled();
  });

  it("does not add application cleanup after a network failure", async () => {
    const test = harness(session("manager-1", 30_000));
    test.refreshSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(test.run()).resolves.toBe("transient-failure");

    expect(test.clearStaleAuth).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalled();
  });

  it("does not let an in-flight refresh for the previous owner clear the new owner", async () => {
    const manager = session("manager-1", 30_000);
    const resident = session("resident-1", 60 * 60 * 1000);
    const test = harness(manager);
    const pending = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string } | null;
    }>();
    test.refreshSession.mockReturnValueOnce(pending.promise);

    const managerRefresh = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    test.setSession(resident);
    await expect(test.run()).resolves.toBe("not-due");
    pending.resolve({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(managerRefresh).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight refresh when auth changes owners without another run", async () => {
    const manager = session("manager-1", 30_000);
    const resident = session("resident-1", 60 * 60 * 1000);
    const test = harness(manager);
    const pending = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string } | null;
    }>();
    test.refreshSession.mockReturnValueOnce(pending.promise);

    const managerRefresh = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    test.observeAuthLifecycle(resident);
    pending.resolve({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(managerRefresh).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("invalidates A to B to A transitions even when no keepalive runs for B", async () => {
    const firstManagerLogin = session("manager-1", 30_000);
    const resident = session("resident-1", 60 * 60 * 1000);
    const secondManagerObservation = {
      ...firstManagerLogin,
      expires_at: Math.floor((NOW + 60 * 60 * 1000) / 1000),
    };
    const test = harness(firstManagerLogin);
    const pending = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string } | null;
    }>();
    test.refreshSession.mockReturnValueOnce(pending.promise);

    const oldRefresh = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    test.observeAuthLifecycle(resident);
    test.observeAuthLifecycle(secondManagerObservation);
    pending.resolve({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(oldRefresh).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("does not revive a successful pending first read across A to B to A", async () => {
    const active = session("manager-1", 60 * 60 * 1000);
    const nearExpiry = { ...active, expires_at: Math.floor((NOW + 30_000) / 1000) };
    const test = harness(active);

    await expect(test.run()).resolves.toBe("not-due");
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const detachedRead = test.run();
    test.observeAuthLifecycle(session("resident-1", 60 * 60 * 1000));
    test.observeAuthLifecycle(active);
    pending.resolve({ session: nearExpiry, error: null });

    await expect(detachedRead).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledTimes(2);
    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("does not revive a successful pending first read after same-user re-login", async () => {
    const firstLogin = session("manager-1", 60 * 60 * 1000);
    const secondLogin = {
      ...session("manager-1", 30_000),
      refresh_token: "rotated-after-sign-in",
    };
    const test = harness(firstLogin);

    await expect(test.run()).resolves.toBe("not-due");
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const detachedRead = test.run();
    test.observeAuthLifecycle(null);
    test.observeAuthLifecycle(secondLogin);
    pending.resolve({ session: secondLogin, error: null });

    await expect(detachedRead).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledTimes(2);
    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("does not revive a successful pending first read after invalidation", async () => {
    const active = session("manager-1", 60 * 60 * 1000);
    const test = harness(active);

    await expect(test.run()).resolves.toBe("not-due");
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const detachedRead = test.run();
    test.invalidate();
    pending.resolve({ session: session("manager-1", 30_000), error: null });

    await expect(detachedRead).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledTimes(2);
    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("rechecks lifecycle ownership between read completion and its outer continuation", async () => {
    const active = session("manager-1", 60 * 60 * 1000);
    const test = harness(active);

    await expect(test.run()).resolves.toBe("not-due");
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const detachedRead = test.run();
    pending.resolve({ session: session("manager-1", 30_000), error: null });
    queueMicrotask(() => {
      test.observeAuthLifecycle(session("resident-1", 60 * 60 * 1000));
    });

    await expect(detachedRead).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledTimes(2);
    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).toHaveBeenCalledOnce();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("detaches when getSession renews and emits TOKEN_REFRESHED before resolving", async () => {
    const stale = session("manager-1", 30_000);
    const renewed = {
      ...session("manager-1", 60 * 60 * 1000),
      refresh_token: "rotated-by-sdk",
    };
    const test = harness(stale);
    const pending = deferred<{ session: Session | null; error: null }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const sdkRead = test.run();
    test.observeAuthLifecycle(renewed);
    pending.resolve({ session: renewed, error: null });

    await expect(sdkRead).resolves.toBe("owner-changed");
    expect(test.getSession).toHaveBeenCalledOnce();
    expect(test.refreshSession).not.toHaveBeenCalled();
    expect(test.markSignedIn).not.toHaveBeenCalled();
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("invalidates a previous login when the same user signs out and signs in again", async () => {
    const firstLogin = session("manager-1", 30_000);
    const secondLogin = { ...firstLogin, refresh_token: "rotated-after-sign-in" };
    const test = harness(firstLogin);
    const pending = deferred<{
      data: { session: Session | null };
      error: { status: number; message: string } | null;
    }>();
    test.refreshSession.mockReturnValueOnce(pending.promise);

    const oldRefresh = test.run();
    await vi.waitFor(() => expect(test.refreshSession).toHaveBeenCalledOnce());
    test.observeAuthLifecycle(null);
    test.observeAuthLifecycle(secondLogin);
    pending.resolve({
      data: { session: null },
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(oldRefresh).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("routes a returned permanent first-read error through guarded cleanup", async () => {
    const test = harness(null);
    test.getSession.mockResolvedValueOnce({
      session: null,
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(test.run()).resolves.toBe("permanent-failure");
    expect(test.clearStaleAuth).toHaveBeenCalledOnce();
  });

  it("does not clean up when a first read becomes stale before returning", async () => {
    const test = harness(null);
    const pending = deferred<{
      session: Session | null;
      error: { status: number; message: string };
    }>();
    test.getSession.mockReturnValueOnce(pending.promise);

    const read = test.run();
    test.observeAuthLifecycle(session("resident-1", 60 * 60 * 1000));
    pending.resolve({
      session: null,
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(read).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("does not clean up when a second read becomes stale before returning", async () => {
    const current = session("manager-1", 30_000);
    const test = harness(current);
    const pending = deferred<{
      session: Session | null;
      error: { status: number; message: string };
    }>();
    test.getSession
      .mockResolvedValueOnce({ session: current, error: null })
      .mockReturnValueOnce(pending.promise);

    const read = test.run();
    await vi.waitFor(() => expect(test.getSession).toHaveBeenCalledTimes(2));
    test.observeAuthLifecycle(session("resident-1", 60 * 60 * 1000));
    pending.resolve({
      session: null,
      error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
    });

    await expect(read).resolves.toBe("owner-changed");
    expect(test.clearStaleAuth).not.toHaveBeenCalled();
  });

  it("routes returned and thrown permanent second-read errors through guarded cleanup", async () => {
    const current = session("manager-1", 30_000);
    const returned = harness(current);
    returned.getSession
      .mockResolvedValueOnce({ session: current, error: null })
      .mockResolvedValueOnce({
        session: null,
        error: { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" },
      });
    await expect(returned.run()).resolves.toBe("permanent-failure");
    expect(returned.clearStaleAuth).toHaveBeenCalledOnce();

    const thrown = harness(current);
    thrown.getSession
      .mockResolvedValueOnce({ session: current, error: null })
      .mockRejectedValueOnce(new Error("Invalid Refresh Token: Refresh Token Not Found"));
    await expect(thrown.run()).resolves.toBe("permanent-failure");
    expect(thrown.clearStaleAuth).toHaveBeenCalledOnce();
  });

  it("treats 429 and network read errors as transient without application cleanup", async () => {
    const rateLimited = harness(null);
    rateLimited.getSession.mockResolvedValueOnce({
      session: null,
      error: { status: 429, message: "Too many requests" },
    });
    await expect(rateLimited.run()).resolves.toBe("transient-failure");
    expect(rateLimited.clearStaleAuth).not.toHaveBeenCalled();

    const offline = harness(null);
    offline.getSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(offline.run()).resolves.toBe("transient-failure");
    expect(offline.clearStaleAuth).not.toHaveBeenCalled();
  });
});
