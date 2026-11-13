import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "mgr-1" } as { id: string } | null,
  decide: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "1.2.3.4" }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://proplane.ai" }));
vi.mock("@/lib/screening/adverse-action.server", () => ({
  decideAdverseAction: h.decide,
  finalizeAdverseAction: h.finalize,
  cancelAdverseAction: h.cancel,
  loadAdverseActionApplication: vi.fn(),
  loadLatestAdverseAction: vi.fn(),
  adverseActionStatusFor: vi.fn(),
}));

import { POST } from "@/app/api/screening/adverse-action/route";

const post = (body: unknown) => POST(new Request("https://proplane.ai/api/screening/adverse-action", { method: "POST", body: JSON.stringify(body) }));
const ok = { ok: true, status: { stage: "none" } };

beforeEach(() => {
  h.user = { id: "mgr-1" };
  for (const fn of [h.decide, h.finalize, h.cancel]) fn.mockReset().mockResolvedValue(ok);
});

describe("POST /api/screening/adverse-action", () => {
  it("requires the manager's answer: a missing or non-boolean 'based on the report' is refused before anything runs", async () => {
    for (const basedOnReport of [undefined, null, "yes", 1, "false"]) {
      const res = await post({ applicationId: "app-1", action: "decide", basedOnReport });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "answer_required" });
    }
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("passes an explicit yes or no through, and the origin the notice link is built on", async () => {
    expect((await post({ applicationId: "app-1", action: "decide", basedOnReport: true })).status).toBe(200);
    expect(h.decide).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: "app-1", basedOnReport: true, origin: "https://proplane.ai", user: h.user }));
    expect((await post({ applicationId: "app-1", action: "decide", basedOnReport: false })).status).toBe(200);
    expect(h.decide).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ basedOnReport: false }));
  });

  it("routes finalize and cancel, and refuses unknown actions and anonymous callers", async () => {
    await post({ applicationId: "app-1", action: "finalize" });
    await post({ applicationId: "app-1", action: "cancel" });
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect((await post({ applicationId: "app-1", action: "approve" })).status).toBe(400);
    expect((await post({ action: "finalize" })).status).toBe(400);
    h.user = null;
    expect((await post({ applicationId: "app-1", action: "finalize" })).status).toBe(401);
  });

  it("surfaces a refusal (waiting period) with its code and status", async () => {
    h.finalize.mockResolvedValue({ ok: false, status: 409, error: "The waiting period has not ended.", code: "waiting_period" });
    const res = await post({ applicationId: "app-1", action: "finalize" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "waiting_period" });
  });
});
