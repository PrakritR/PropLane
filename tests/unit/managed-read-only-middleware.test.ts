import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const state = vi.hoisted(() => ({
  user: { id: "client" } as { id: string } | null,
  userError: null as { status?: number; message?: string; name?: string; code?: string } | null,
  rpc: vi.fn(),
  rpcCalls: 0,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.userError }),
      signOut: async () => ({}),
    },
    rpc: (name: string) => {
      state.rpcCalls += 1;
      return state.rpc(name);
    },
  }),
}));

import { middleware } from "@/middleware";

function req(method: string, path: string, cookies: Record<string, string> = {}, withSession = true) {
  const jar = { ...(withSession ? { "sb-proj-auth-token": "x" } : {}), ...cookies };
  return new NextRequest(`https://proplane.ai${path}`, {
    method,
    headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
}

const ENV = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  state.user = { id: "client" };
  state.userError = null;
  state.rpcCalls = 0;
  state.rpc.mockReset();
});
afterEach(() => {
  if (ENV.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV.url;
  if (ENV.anon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ENV.anon;
});

describe("middleware: managed (PropLane Service) workspaces are view-only", () => {
  it("blocks POST /api/property-records for a locked client with the managed code", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await middleware(req(method, "/api/property-records"));
      expect(res.status, method).toBe(403);
      expect(await res.json()).toEqual({ error: "This workspace is managed by PropLane. It's view-only.", code: "read_only_managed" });
    }
    const res = await middleware(req("POST", "/api/property-records", { "proplane-workspace": WS }));
    expect(res.status).toBe(403);
  });

  it("lets her own account, plan purchase and money through without asking the database", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    for (const path of ["/api/auth/sign-out", "/api/stripe/checkout", "/api/owner/finances/withdraw", "/api/portal/proplane-balance/withdraw", "/api/agent/chat"]) {
      const res = await middleware(req("POST", path));
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).not.toBe(503);
    }
    expect(state.rpcCalls).toBe(0);
  });

  it("never touches reads", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    const res = await middleware(req("GET", "/api/property-records"));
    expect(res.status).not.toBe(403);
    expect(state.rpcCalls).toBe(0);
  });

  it("a database error refuses the write with 503 (fail closed), including a missing function", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "function public.managed_read_only_owner_locked() does not exist" } });
    const res = await middleware(req("POST", "/api/property-records"));
    expect(res.status).toBe(503);
    state.rpc.mockRejectedValue(new Error("network"));
    expect((await middleware(req("POST", "/api/property-records"))).status).toBe(503);
  });

  it("an unlocked owner, and a seated admin of the same workspace, are unaffected", async () => {
    state.rpc.mockResolvedValue({ data: false, error: null });
    expect((await middleware(req("POST", "/api/property-records"))).status).toBe(200);
    expect((await middleware(req("POST", "/api/property-records", { "proplane-workspace": WS }))).status).toBe(200);
  });

  it("the lock is account-wide: a forged, other-workspace or locked cookie, or none, all get 403", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    for (const cookies of [{}, { "proplane-workspace": WS }, { "proplane-workspace": OTHER }, { "proplane-workspace": "not-a-real-id" }, { "proplane-workspace": "" }]) {
      const res = await middleware(req("POST", "/api/property-records", cookies));
      expect(res.status, JSON.stringify(cookies)).toBe(403);
    }
    expect(state.rpc).toHaveBeenCalledWith("managed_read_only_owner_locked");
  });

  it("an encoded dot-dot path out of /api is still guarded", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    const res = await middleware(req("POST", "/api/x/abc%2F..%2F..%2F..%2Fy"));
    expect(res.status).toBe(403);
  });

  it("a getUser error that is not a definite dead session refuses the write with 503; a dead session does not", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    state.user = null;
    for (const err of [{ status: 429, message: "rate" }, { status: 503, message: "down" }, { status: 0, name: "AuthRetryableFetchError", message: "fetch failed" }]) {
      state.userError = err;
      const res = await middleware(req("POST", "/api/property-records"));
      expect(res.status, JSON.stringify(err)).toBe(503);
    }
    for (const err of [{ status: 401, code: "session_not_found" }, { name: "AuthSessionMissingError", message: "Auth session missing!" }, { status: 400, message: "Invalid Refresh Token: Refresh Token Not Found" }]) {
      state.userError = err;
      expect((await middleware(req("POST", "/api/property-records"))).status, JSON.stringify(err)).toBe(200);
    }
  });

  it("a request with no session cookie (webhook, API key) or no user is not looked up", async () => {
    state.rpc.mockResolvedValue({ data: true, error: null });
    expect((await middleware(req("POST", "/api/property-records", {}, false))).status).toBe(200);
    state.user = null;
    expect((await middleware(req("POST", "/api/property-records"))).status).toBe(200);
    expect(state.rpcCalls).toBe(0);
  });
});
