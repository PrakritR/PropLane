import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), limit: vi.fn(async (..._a: unknown[]) => ({ ok: true })) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/invite-links/invite-links.server", () => ({ previewInviteLink: mocks.preview }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit, clientIpFrom: () => "9.9.9.9" }));

import { POST } from "@/app/api/pro/invite-links/preview/route";

const call = (body: unknown) => POST(new Request("http://x/api/pro/invite-links/preview", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.limit.mockResolvedValue({ ok: true });
});

describe("POST /api/pro/invite-links/preview (unauthenticated)", () => {
  it("404s a workspace code without touching the lookup", async () => {
    const res = await call({ token: "SH-7K4Q2M" });
    expect(res.status).toBe(404);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("still resolves a token", async () => {
    mocks.preview.mockResolvedValue({ kind: "manager", ownerUserId: "o", ownerName: "A", workspaceName: null, propertyLabels: [], unusableReason: null });
    expect((await call({ token: "a-long-token-value-1234567890abcdef" })).status).toBe(200);
  });

  it("429s past the per-IP limit", async () => {
    mocks.limit.mockResolvedValue({ ok: false });
    expect((await call({ token: "x" })).status).toBe(429);
  });
});
