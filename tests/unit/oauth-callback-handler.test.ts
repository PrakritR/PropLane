import { describe, expect, it, vi, beforeEach } from "vitest";
const recoveryRedirect = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: recoveryRedirect }));
import { NextRequest } from "next/server";

let capturedSetAll: ((cookies: { name: string; value: string; options?: object }[]) => void) | null = null;

const exchangeCodeForSession = vi.fn(async () => {
  capturedSetAll?.([
    { name: "sb-access-token", value: "token-value", options: { httpOnly: true, path: "/" } },
  ]);
  return { data: { session: { provider_token: null, provider_refresh_token: null } }, error: null };
});

const getUser = vi.fn(async () => ({ data: { user: { id: "user-1", email: "a@example.com" } } }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _anon: string, options: { cookies: { setAll: typeof capturedSetAll } }) => {
    capturedSetAll = options.cookies.setAll;
    return {
      auth: {
        exchangeCodeForSession,
        getUser,
      },
    };
  }),
}));

vi.mock("@/lib/auth/reconcile-auth-accounts-by-email", () => ({
  reconcileAuthAccountsByEmail: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/manager-portal-provision", () => ({
  ensureFreeManagerPortalAccess: vi.fn(async () => ({ status: "skipped", reason: "test" })),
}));

vi.mock("@/lib/auth/resolve-oauth-portal-access", () => ({
  resolveOAuthPortalRedirect: vi.fn(async () => "/partner/pricing"),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/google-calendar/link-from-auth.server", () => ({
  maybeLinkGoogleCalendarFromOAuthSession: vi.fn(async () => ({ linked: false, reason: "test" })),
  shouldRedirectToGoogleCalendarConnect: vi.fn(() => false),
  signedInWithGoogle: vi.fn(() => false),
}));

vi.mock("@/lib/google-calendar/debug-log.server", () => ({
  debugGoogleCalendarLog: vi.fn(),
}));

describe("handleOAuthCallback", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedSetAll = null;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  it("replays auth cookies when redirect path changes after resolve", async () => {
    const { handleOAuthCallback } = await import("@/lib/auth/oauth-callback-handler");

    const request = new NextRequest("https://axis.example.com/auth/callback?code=abc123");
    const response = await handleOAuthCallback(request, "/auth/continue");

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://axis.example.com/partner/pricing");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-access-token=token-value");
  });

  it("redirects to the Host header origin, not the 0.0.0.0 bind address in request.url", async () => {
    const { handleOAuthCallback } = await import("@/lib/auth/oauth-callback-handler");

    // `next dev --hostname 0.0.0.0` reports request.url on the bind address even
    // when the browser is on localhost — redirects must follow the Host header.
    const request = new NextRequest("http://0.0.0.0:3000/auth/callback/partner-pricing?code=abc123", {
      headers: { host: "localhost:3000" },
    });
    const response = await handleOAuthCallback(request, "/partner/pricing?google_signed_in=1");

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/partner/pricing");
  });

  it("uses the Host header origin for auth failure redirects", async () => {
    const { handleOAuthCallback } = await import("@/lib/auth/oauth-callback-handler");

    const request = new NextRequest("http://0.0.0.0:3000/auth/callback?error=access_denied", {
      headers: { host: "localhost:3000" },
    });
    const response = await handleOAuthCallback(request, "/auth/continue");

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("http://localhost:3000/auth/sign-in?")).toBe(true);
  });

  // `/auth/sign-in` allow-lists `?message=` against the copy this codebase authored, so any
  // message this route emits inline instead of importing degrades to the generic sentence and
  // the real explanation is lost — the same silent failure the native path had.
  it("emits only allow-listed copy, so every authored reason survives to the sign-in screen", async () => {
    const { handleOAuthCallback } = await import("@/lib/auth/oauth-callback-handler");
    const { oauthErrorFromParams, OAUTH_GENERIC_FAILURE_MESSAGE } = await import(
      "@/lib/auth/oauth-error-params"
    );
    const {
      OAUTH_CALLBACK_MISSING_CODE_MESSAGE,
      OAUTH_CALLBACK_SESSION_FAILED_MESSAGE,
      OAUTH_NOT_COMPLETED_MESSAGE,
    } = await import("@/lib/auth/oauth-failure-messages");

    exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null },
      error: { message: "" },
    } as unknown as never);

    const cases: Array<{ url: string; expected: string }> = [
      { url: "https://axis.example.com/auth/callback", expected: OAUTH_CALLBACK_MISSING_CODE_MESSAGE },
      { url: "https://axis.example.com/auth/callback?error=access_denied", expected: OAUTH_NOT_COMPLETED_MESSAGE },
      { url: "https://axis.example.com/auth/callback?code=abc123", expected: OAUTH_CALLBACK_SESSION_FAILED_MESSAGE },
    ];

    for (const { url, expected } of cases) {
      const response = await handleOAuthCallback(new NextRequest(url), "/auth/continue");
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/auth/sign-in");
      expect(location.searchParams.get("message")).toBe(expected);
      expect(oauthErrorFromParams(location.searchParams)).toBe(expected);
      expect(oauthErrorFromParams(location.searchParams)).not.toBe(OAUTH_GENERIC_FAILURE_MESSAGE);
    }
  });
});
