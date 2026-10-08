import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const getUser = vi.fn();
const signOut = vi.fn();
let capturedCookieOptions: unknown;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _anon: string, options: { cookieOptions?: unknown }) => {
    capturedCookieOptions = options.cookieOptions;
    return { auth: { getUser, signOut } };
  },
}));

import { middleware } from "@/middleware";
import {
  isSecureAuthContext,
  SUPABASE_AUTH_COOKIE_MAX_AGE_SECONDS,
  supabaseAuthCookieOptions,
} from "@/lib/supabase/cookie-options";
import {
  getBrowserSessionWithRetry,
  isStaleRefreshTokenError,
  safeBrowserGetSession,
} from "@/lib/supabase/safe-browser-session";

function authError(message: string, extra: { code?: string; status?: number } = {}) {
  return Object.assign(new Error(message), extra);
}

function fakeClient(getSession: () => Promise<unknown>) {
  const client = { auth: { getSession: vi.fn(getSession), signOut: vi.fn().mockResolvedValue({ error: null }) } };
  return client as unknown as Parameters<typeof safeBrowserGetSession>[0] & typeof client;
}

describe("stale refresh token matcher", () => {
  it("matches only definitively dead refresh tokens", () => {
    expect(isStaleRefreshTokenError({ code: "refresh_token_not_found" })).toBe(true);
    expect(isStaleRefreshTokenError(authError("Invalid Refresh Token: Refresh Token Not Found"))).toBe(true);
  });

  it("does not treat rotation races, vanished sessions, or generic 401s as a logout", () => {
    expect(isStaleRefreshTokenError({ code: "refresh_token_already_used" })).toBe(false);
    expect(isStaleRefreshTokenError(authError("Invalid Refresh Token: Already Used"))).toBe(false);
    expect(isStaleRefreshTokenError({ code: "session_not_found" })).toBe(false);
    expect(isStaleRefreshTokenError({ status: 401, message: "could not refresh the thing" })).toBe(false);
    expect(isStaleRefreshTokenError({ status: 429, message: "rate limited" })).toBe(false);
    expect(isStaleRefreshTokenError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("safeBrowserGetSession", () => {
  it("keeps the cookies and reports a transient error on a network failure or 429", async () => {
    const offline = fakeClient(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(safeBrowserGetSession(offline)).resolves.toEqual({ session: null, transientError: true });
    expect(offline.auth.signOut).not.toHaveBeenCalled();

    const limited = fakeClient(() =>
      Promise.resolve({ data: { session: null }, error: authError("rate limit", { status: 429 }) }),
    );
    await expect(safeBrowserGetSession(limited)).resolves.toEqual({ session: null, transientError: true });
    expect(limited.auth.signOut).not.toHaveBeenCalled();
  });

  it("clears the local session only for a definitively stale refresh token", async () => {
    const stale = fakeClient(() =>
      Promise.resolve({ data: { session: null }, error: authError("Invalid Refresh Token: Refresh Token Not Found") }),
    );
    const result = await safeBrowserGetSession(stale);
    expect(result.session).toBeNull();
    expect(result.transientError).toBeUndefined();
    expect(stale.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("returns a live session untouched", async () => {
    const session = { user: { id: "u1" } };
    const ok = fakeClient(() => Promise.resolve({ data: { session }, error: null }));
    await expect(safeBrowserGetSession(ok)).resolves.toEqual({ session });
  });
});

describe("getBrowserSessionWithRetry", () => {
  it("retries a transient failure with backoff and settles on the real answer", async () => {
    const session = { user: { id: "u1" } };
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve({ data: { session }, error: null });
    });
    const sleeps: number[] = [];
    const result = await getBrowserSessionWithRetry(client, {
      delaysMs: [10, 20, 40],
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(result).toEqual({ session, settled: true });
    expect(sleeps).toEqual([10, 20]);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("is NOT settled when every attempt fails transiently: never a published logout", async () => {
    const client = fakeClient(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await getBrowserSessionWithRetry(client, { delaysMs: [1, 1], sleep: async () => undefined });
    expect(result).toEqual({ session: null, settled: false });
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(client.auth.getSession).toHaveBeenCalledTimes(3);
  });

  it("settles immediately on a genuine no-session answer", async () => {
    const client = fakeClient(() => Promise.resolve({ data: { session: null }, error: null }));
    await expect(getBrowserSessionWithRetry(client, { delaysMs: [1] })).resolves.toEqual({ session: null, settled: true });
  });
});

describe("portal session hook never publishes a transient failure as signed out", () => {
  const hook = read("src/hooks/use-portal-session.ts");
  it("reads through the retrying helper and ignores an empty INITIAL_SESSION", () => {
    expect(hook).toContain("getBrowserSessionWithRetry");
    expect(hook).toContain('event === "INITIAL_SESSION" && !session');
  });
});

describe("middleware session handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCookieOptions = undefined;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  const portalRequest = () => new NextRequest("https://proplane.ai/portal/dashboard");

  it("signs out with LOCAL scope only on a definitively stale refresh token, and still redirects", async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: authError("Invalid Refresh Token: Refresh Token Not Found", { code: "refresh_token_not_found", status: 400 }),
    });
    signOut.mockResolvedValue({ error: null });
    const res = await middleware(portalRequest());
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/sign-in");
  });

  it("does not sign out on a rotation race, a 429, or a 5xx; the cookies stay", async () => {
    for (const error of [
      authError("Invalid Refresh Token: Already Used", { code: "refresh_token_already_used", status: 400 }),
      authError("session missing", { code: "session_not_found", status: 403 }),
      authError("rate limited", { status: 429 }),
      authError("upstream", { status: 503 }),
    ]) {
      getUser.mockResolvedValueOnce({ data: { user: null }, error });
      await middleware(portalRequest());
    }
    expect(signOut).not.toHaveBeenCalled();
  });

  it("pins the 400-day auth cookie on the server client", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await middleware(portalRequest());
    expect(capturedCookieOptions).toEqual({
      path: "/",
      maxAge: SUPABASE_AUTH_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
      secure: true,
    });
  });

  it("does not demand Secure on plain-http localhost", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await middleware(new NextRequest("http://localhost:3001/portal/dashboard"));
    expect((capturedCookieOptions as { secure: boolean }).secure).toBe(false);
  });
});

describe("auth cookie options", () => {
  it("is a 400 day, lax, root-path cookie", () => {
    expect(SUPABASE_AUTH_COOKIE_MAX_AGE_SECONDS).toBe(34_560_000);
    expect(supabaseAuthCookieOptions({ secure: true })).toEqual({
      path: "/",
      maxAge: 34_560_000,
      sameSite: "lax",
      secure: true,
    });
    expect(isSecureAuthContext("https:", "proplane.ai")).toBe(true);
    expect(isSecureAuthContext("http:", "localhost")).toBe(false);
    expect(isSecureAuthContext("https:", "localhost")).toBe(true);
  });

  it("is passed to every Supabase auth client", () => {
    for (const file of [
      "src/middleware.ts",
      "src/lib/supabase/server.ts",
      "src/lib/supabase/browser.ts",
      "src/lib/auth/oauth-callback-handler.ts",
    ]) {
      expect(read(file), file).toContain("cookieOptions: supabaseAuthCookieOptions(");
    }
  });
});

describe("global sign-out is gone from the request path", () => {
  it("server profile resolution signs out locally", () => {
    const src = read("src/lib/auth/server-profile.ts");
    expect(src).toContain('signOut({ scope: "local" })');
    expect(src).not.toMatch(/signOut\(\)/);
  });
});

describe("keepalive coverage", () => {
  it("mounts on the vendor and admin portals like the manager and resident ones", () => {
    for (const layout of [
      "src/app/portal/layout.tsx",
      "src/app/resident/layout.tsx",
      "src/app/vendor/layout.tsx",
      "src/app/admin/layout.tsx",
    ]) {
      expect(read(layout), layout).toContain("<PortalSessionKeepalive />");
    }
  });

  it("the native resume handler triggers the same refresh", () => {
    const bridge = read("src/components/native/native-bridge.tsx");
    expect(bridge).toContain("portal-session-keepalive");
    expect(bridge).toContain("refreshPortalSession");
  });
});
