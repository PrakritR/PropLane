import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import { PREVIEW_PORTAL_COOKIE, PREVIEW_UID_COOKIE } from "@/lib/auth/admin-preview";

const getUser = vi.fn();
const signOut = vi.fn();
const track = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser, signOut },
  })),
}));
vi.mock("@/lib/analytics/posthog", () => ({
  track: (...a: unknown[]) => track(...a),
}));

const route = await import("@/app/api/auth/sign-out/route");

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  signOut.mockResolvedValue({ error: null });
});

describe("POST /api/auth/sign-out", () => {
  it("clears the workspace cookie alongside the portal-session cookies", async () => {
    const res = await route.POST();
    expect(res.status).toBe(200);

    const setCookie = res.headers.getSetCookie();
    const cleared = (name: string) =>
      setCookie.some((line) => line.startsWith(`${name}=;`) && /max-age=0/i.test(line));

    // The regression this guards: WORKSPACE_COOKIE used to be left standing
    // after sign-out, so the next account to sign in on this browser landed
    // inside whichever workspace the previous account last selected.
    expect(cleared(WORKSPACE_COOKIE)).toBe(true);
    expect(cleared(ACTIVE_PORTAL_COOKIE)).toBe(true);
    expect(cleared(PREVIEW_UID_COOKIE)).toBe(true);
    expect(cleared(PREVIEW_PORTAL_COOKIE)).toBe(true);

    // Same result via the cookie-jar accessor, for readers who prefer it.
    const workspaceCookie = res.cookies.get(WORKSPACE_COOKIE);
    expect(workspaceCookie?.value).toBe("");
    expect(workspaceCookie?.maxAge).toBe(0);
  });

  it("still clears the workspace cookie when no one was signed in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await route.POST();
    expect(res.status).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect(res.cookies.get(WORKSPACE_COOKIE)?.value).toBe("");
  });
});
