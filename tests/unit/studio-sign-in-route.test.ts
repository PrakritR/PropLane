import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for GET /api/dev/studio-sign-in. The guard function
 * itself (host/env/project checks) is covered exhaustively in
 * tests/unit/studio-sign-in-guard.test.ts — this file exercises the HANDLER:
 * every refusal returns a bare 404 (never a redirect or a helpful error body,
 * since this route must not be a discoverable surface outside local dev), and
 * the happy path signs in with the right account and redirects same-origin.
 */

const state = vi.hoisted(() => ({
  allowed: true,
  signInCalls: [] as { email: string; password: string }[],
  signInError: null as { message: string } | null,
}));

vi.mock("@/lib/dev/studio-sign-in.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dev/studio-sign-in.server")>(
    "@/lib/dev/studio-sign-in.server",
  );
  return {
    ...actual,
    studioSignInAllowed: () => state.allowed,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async (creds: { email: string; password: string }) => {
        state.signInCalls.push(creds);
        return { error: state.signInError };
      },
    },
  }),
}));

describe("GET /api/dev/studio-sign-in", () => {
  beforeEach(() => {
    state.allowed = true;
    state.signInCalls = [];
    state.signInError = null;
    vi.resetModules();
  });

  function get(qs: string) {
    return import("@/app/api/dev/studio-sign-in/route").then(({ GET }) =>
      GET(new Request(`http://localhost:3019/api/dev/studio-sign-in${qs}`, { headers: { host: "localhost:3019" } })),
    );
  }

  it("refuses with a bare 404 when the guard denies, before touching Supabase", async () => {
    state.allowed = false;
    const res = await get("?as=manager&next=/portal/dashboard");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(state.signInCalls).toHaveLength(0);
  });

  it("rejects an unknown role with 400 and never signs in", async () => {
    const res = await get("?as=superadmin&next=/portal/dashboard");
    expect(res.status).toBe(400);
    expect(state.signInCalls).toHaveLength(0);
  });

  it("rejects a missing role with 400", async () => {
    const res = await get("?next=/portal/dashboard");
    expect(res.status).toBe(400);
    expect(state.signInCalls).toHaveLength(0);
  });

  it("signs in as the manager sandbox account and redirects to the requested same-origin path", async () => {
    const res = await get("?as=manager&next=/portal/dashboard");
    expect(state.signInCalls).toEqual([{ email: "testeverything@test.proplane.local", password: "TestEverything123!" }]);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3019/portal/dashboard");
  });

  it("signs in as the resident account for as=resident", async () => {
    await get("?as=resident&next=/resident/dashboard");
    expect(state.signInCalls).toEqual([{ email: "resident@test.proplane.local", password: "TestResident123!" }]);
  });

  it("falls back to / when next is missing", async () => {
    const res = await get("?as=vendor");
    expect(res.headers.get("location")).toBe("http://localhost:3019/");
  });

  it("rejects an absolute-URL next (open redirect) and falls back to /", async () => {
    const res = await get("?as=vendor&next=" + encodeURIComponent("https://evil.example.com/steal"));
    expect(res.headers.get("location")).toBe("http://localhost:3019/");
  });

  it("rejects a protocol-relative next (open redirect) and falls back to /", async () => {
    const res = await get("?as=vendor&next=" + encodeURIComponent("//evil.example.com/steal"));
    expect(res.headers.get("location")).toBe("http://localhost:3019/");
  });

  it("returns 500 with no cookies set when Supabase sign-in fails", async () => {
    state.signInError = { message: "Invalid login credentials" };
    const res = await get("?as=admin&next=/admin/dashboard");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("admin");
  });
});
