import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** "Message the host" opens the resident's existing host-team thread (no compose prefill); the lookup is authorized by the resident's own tours. */

describe("residentTourThreadHref", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the thread url when one is stored, else the Communication list, never a compose", async () => {
    const { residentTourThreadHref } = await import("@/lib/resident-tour-thread-client");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ threadId: "property_mgr_abc:1" }), { status: 200 })));
    expect(await residentTourThreadHref("/resident", "inq-1")).toBe("/resident/communication/active/property_mgr_abc%3A1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ threadId: null }), { status: 200 })));
    expect(await residentTourThreadHref("/resident", "inq-1")).toBe("/resident/communication/active");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await residentTourThreadHref("/resident", "inq-1")).toBe("/resident/communication/active");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await residentTourThreadHref("/resident", "inq-1")).toBe("/resident/communication/active");
    expect(await residentTourThreadHref("/resident", "  ")).toBe("/resident/communication/active");
  });
});

const session = vi.hoisted(() => ({ user: { id: "res-1", email: "jordan@example.com" } as { id: string; email: string } | null }));
const tours = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
const finder = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, result: "thread-1" as string | null }));

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: async () => ({ user: session.user, profile: session.user ? { email: session.user.email } : null }),
}));
vi.mock("@/lib/auth/ensure-resident-portal-access.server", () => ({ ensureMayAccessResidentPortal: async () => ({ ok: true }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@example.com" } }) }) }) }),
  }),
}));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadResidentTourViews: async () => tours.list }));
vi.mock("@/lib/property-manager-inbox-thread.server", () => ({
  findResidentPropertyManagerThreadId: async (_db: unknown, input: Record<string, unknown>) => {
    finder.calls.push(input);
    return finder.result;
  },
}));

describe("GET /api/portal-resident-tours/thread", () => {
  beforeEach(() => {
    session.user = { id: "res-1", email: "jordan@example.com" };
    tours.list = [{ inquiryId: "inq-1", managerUserId: "owner-1", propertyId: "prop-cedar" }];
    finder.calls.length = 0;
    finder.result = "thread-1";
  });

  const call = async (qs: string) => {
    const { GET } = await import("@/app/api/portal-resident-tours/thread/route");
    return GET(new Request(`http://localhost/api/portal-resident-tours/thread${qs}`));
  };

  it("derives manager and house from the resident's own tour, never from the request", async () => {
    const res = await call("?inquiryId=inq-1&managerUserId=attacker&propertyId=other");
    expect(await res.json()).toEqual({ threadId: "thread-1" });
    expect(finder.calls[0]).toMatchObject({ residentUserId: "res-1", managerUserId: "owner-1", propertyId: "prop-cedar" });
  });

  it("refuses a tour that is not theirs, a missing id, and a signed-out caller", async () => {
    expect((await call("?inquiryId=someone-elses")).status).toBe(404);
    expect((await call("")).status).toBe(400);
    session.user = null;
    expect((await call("?inquiryId=inq-1")).status).toBe(401);
    expect(finder.calls).toHaveLength(0);
  });
});
