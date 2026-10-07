// Reviews ⋯ → Edit reply (vendor-portal-redesign-1006): PATCH edits a reply
// already sent, scoped to the signed-in vendor's own review; POST stays the
// first-reply-only verb (409 over an existing reply).
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  access: { ok: true, userId: "vendor-1" } as { ok: true; userId: string } | { ok: false; status: 401 | 403 },
  updated: null as null | Record<string, unknown>,
  filters: [] as string[],
  existingReply: "Thanks!" as string | null,
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: async () => state.access }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (patch: Record<string, unknown>) => {
        state.updated = patch;
        return q;
      };
      q.eq = (col: string, value: string) => {
        state.filters.push(`${col}=${value}`);
        return q;
      };
      q.not = (col: string, op: string) => {
        state.filters.push(`${col} not ${op} null`);
        return q;
      };
      q.maybeSingle = async () =>
        state.updated
          ? state.existingReply === null && state.filters.some((f) => f.includes("not is null"))
            ? { data: null, error: null }
            : { data: { id: "r1", stars: 5, body: "b", vendor_reply: state.updated.vendor_reply, vendor_replied_at: "x", created_at: "x", updated_at: "x" }, error: null }
          : { data: { id: "r1", vendor_reply: state.existingReply }, error: null };
      return q;
    },
  }),
}));

import { PATCH, POST } from "@/app/api/vendor/reviews/[id]/reply/route";

const ctx = { params: Promise.resolve({ id: "r1" }) };
const req = (body: unknown, method = "PATCH") =>
  new Request("http://x/api/vendor/reviews/r1/reply", { method, body: JSON.stringify(body) });

beforeEach(() => {
  state.access = { ok: true, userId: "vendor-1" };
  state.updated = null;
  state.filters = [];
  state.existingReply = "Thanks!";
});

describe("PATCH /api/vendor/reviews/[id]/reply", () => {
  it("edits the reply, pinned to the signed-in vendor and to a review that already has one", async () => {
    const res = await PATCH(req({ reply: "  Thanks so much!  " }), ctx);
    expect(res.status).toBe(200);
    expect(state.updated?.vendor_reply).toBe("Thanks so much!");
    expect(state.filters).toContain("vendor_user_id=vendor-1");
    expect(state.filters).toContain("id=r1");
    expect(state.filters.some((f) => f.includes("vendor_reply not is null"))).toBe(true);
  });

  it("404s when there is no reply to edit (the first reply is a POST)", async () => {
    state.existingReply = null;
    const res = await PATCH(req({ reply: "hi" }), ctx);
    expect(res.status).toBe(404);
  });

  it("rejects an empty reply and an unauthenticated caller", async () => {
    expect((await PATCH(req({ reply: "   " }), ctx)).status).toBe(400);
    state.access = { ok: false, status: 401 };
    expect((await PATCH(req({ reply: "hi" }), ctx)).status).toBe(401);
  });
});

describe("POST /api/vendor/reviews/[id]/reply", () => {
  it("still refuses to overwrite an existing reply", async () => {
    const res = await POST(req({ reply: "again" }, "POST"), ctx);
    expect(res.status).toBe(409);
  });
});
