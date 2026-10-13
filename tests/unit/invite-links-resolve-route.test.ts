import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  preview: vi.fn(),
  limit: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/invite-links/invite-links.server", () => ({ previewInviteLink: mocks.preview }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit, clientIpFrom: () => "9.9.9.9" }));

import { POST } from "@/app/api/pro/invite-links/resolve/route";

const call = (body: unknown) =>
  POST(new Request("http://x/api/pro/invite-links/resolve", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  mocks.user = { id: "u1" };
  mocks.preview.mockReset();
  mocks.limit.mockResolvedValue({ ok: true });
});

describe("POST /api/pro/invite-links/resolve", () => {
  it("401s when signed out", async () => {
    mocks.user = null;
    expect((await call({ input: "SH-7K4Q" })).status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("answers every miss with the same 404", async () => {
    mocks.preview.mockResolvedValue(null);
    const unknown = await call({ input: "ZZ-9999" });
    const empty = await call({ input: "  " });
    const junk = await call({ input: 42 });
    for (const res of [unknown, empty, junk]) expect(res.status).toBe(404);
    expect(await unknown.json()).toEqual(await empty.json());
  });

  it("returns the thin preview, never the permission map", async () => {
    mocks.preview.mockResolvedValue({
      kind: "manager",
      ownerUserId: "o1",
      ownerName: "Ambika",
      workspaceName: "SEATTLE HOMES",
      propertyLabels: ["A"],
      teamRole: "admin",
      houseScope: "all",
      houseCount: 1,
      canDo: "x",
      unusableReason: null,
      property_permissions: { secret: true },
    });
    const res = await call({ input: "SH-7K4Q" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceName).toBe("SEATTLE HOMES");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("passes allowCode and also rate limits per IP", async () => {
    mocks.preview.mockResolvedValue(null);
    await call({ input: "SH-7K4Q2M" });
    expect(mocks.preview.mock.calls[0]![3]).toEqual({ allowCode: true });
    const keys = (mocks.limit.mock.calls as unknown as string[][]).map((c) => c[0]);
    expect(keys).toContain("invite-resolve-ip:9.9.9.9");
  });

  it("rate limits guessing", async () => {
    mocks.limit.mockResolvedValue({ ok: false });
    expect((await call({ input: "SH-7K4Q" })).status).toBe(429);
  });
});
