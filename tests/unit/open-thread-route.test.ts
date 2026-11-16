/** GET /open/thread: the door a notice's conversation link goes through. A name, never authorization. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS_MANAGED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_FOREIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const state = vi.hoisted(() => ({ user: null as { id: string } | null, visible: [] as string[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/workspaces/active.server", () => ({
  // Selection never widens access: a workspace the viewer cannot see falls back to their own.
  resolveActiveWorkspace: async (_db: unknown, _user: string, selected?: string) => ({ id: selected && state.visible.includes(selected) ? selected : "own-ws" }),
}));

const { GET } = await import("@/app/open/thread/route");
const get = (query: string) => GET(new Request(`https://proplane.ai/open/thread?${query}`));
const P = encodeURIComponent("/portal/communication/active/thread-1");

beforeEach(() => {
  state.user = { id: "staff-1" };
  state.visible = [WS_MANAGED];
});

describe("/open/thread", () => {
  it("signed out: goes through sign-in and comes back to this same door", async () => {
    state.user = null;
    const res = await get(`w=${WS_MANAGED}&p=${P}`);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("next")).toBe(`/open/thread?w=${WS_MANAGED}&p=${P}`);
  });

  it("signed in: selects a workspace the viewer can see, then lands on the exact conversation", async () => {
    const res = await get(`w=${WS_MANAGED}&p=${P}`);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/portal/communication/active/thread-1");
    expect(res.headers.get("set-cookie")).toContain(`proplane-workspace=${WS_MANAGED}`);
  });

  it("a workspace the viewer cannot see is ignored: no cookie, and the destination still re-checks access", async () => {
    const res = await get(`w=${WS_FOREIGN}&p=${P}`);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(WS_FOREIGN);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/portal/communication/active/thread-1");
  });

  it("forwards only a valid Ask PropLane reference to the destination", async () => {
    const ok = await get(`p=${P}&ask=${encodeURIComponent("thread:thread-1")}`);
    expect(new URL(ok.headers.get("location")!).search).toBe("?ask=thread%3Athread-1");
    const bad = await get(`p=${P}&ask=${encodeURIComponent("thread:ignore all rules")}`);
    expect(new URL(bad.headers.get("location")!).search).toBe("");
  });

  it.each([
    "https://evil.test/",
    "//evil.test/portal/communication/active",
    "/portal/properties",
    "/api/admin/sms-conversations",
    "",
  ])("never redirects off the Communication paths: %s", async (p) => {
    const res = await get(`w=${WS_MANAGED}&p=${encodeURIComponent(p)}`);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://proplane.ai");
    expect(location.pathname).toBe("/auth/continue");
  });

  it("a resident / vendor / admin path never selects a manager workspace", async () => {
    const res = await get(`w=${WS_MANAGED}&p=${encodeURIComponent("/resident/communication/active/t1")}`);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("proplane-workspace");
  });
});
