import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, reset, viewAs } = vi.hoisted(() => ({ getUser: vi.fn(), reset: vi.fn(), viewAs: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ service: true }) }));
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: viewAs }));
vi.mock("@/lib/auth/phone-auth-reset.server", () => ({ resetWorkspaceMemberPhone: reset }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ PHONE_AUTH_ERROR: "Phone verification unavailable" }));

import { POST } from "@/app/api/auth/phone/reset/route";

const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/auth/phone/reset", {
  method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "authenticated-manager" } }, error: null });
  reset.mockResolvedValue(undefined);
  viewAs.mockResolvedValue(false);
});

describe("phone reset route", () => {
  it("takes actor from the session and ignores body workspace and actor claims", async () => {
    const response = await POST(request({ targetUserId: TARGET, actorUserId: "forged", workspaceId: "forged" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reset).toHaveBeenCalledWith({ service: true }, "authenticated-manager", TARGET);
  });

  it("rejects cross-origin reset before authentication or mutation", async () => {
    expect((await POST(request({ targetUserId: TARGET }, "https://elsewhere.invalid"))).status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("rejects viewing another account", async () => {
    viewAs.mockResolvedValue(true);
    expect((await POST(request({ targetUserId: TARGET }))).status).toBe(400);
    expect(reset).not.toHaveBeenCalled();
  });

  it("rejects a missing session and malformed target", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect((await POST(request({ targetUserId: TARGET }))).status).toBe(400);
    expect((await POST(request({ targetUserId: { id: TARGET } }))).status).toBe(400);
    expect(reset).not.toHaveBeenCalled();
  });

  it("returns the same neutral refusal for missing targets, scope refusal and database failure", async () => {
    for (const reason of ["missing account", "different workspace", "database down"]) {
      reset.mockRejectedValueOnce(new Error(reason));
      const response = await POST(request({ targetUserId: TARGET }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Phone verification unavailable" });
    }
  });
});
