import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { POST as signupIntent } from "@/app/api/manager/signup-intent/route";

describe("POST /api/manager/signup-intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);
  });

  it("rejects paid tier without promo waiver", async () => {
    const req = jsonRequest("http://localhost/api/manager/signup-intent", {
      method: "POST",
      body: {
        tier: "pro",
        billing: "monthly",
        email: "mgr@test.com",
        fullName: "Test Manager",
        promo: "",
      },
    });
    const res = await signupIntent(req);
    const { status, data } = await parseJsonResponse<{ code?: string }>(res);
    expect(status).toBe(400);
    expect(data.code).toBe("REQUIRES_CHECKOUT");
  });

  it("creates signup intent with FREE100 promo", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [] }),
          // The waiver path also asks whether staff ended this email's promo (`accountPromoEndedForEmail`).
          ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        insert,
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/manager/signup-intent", {
      method: "POST",
      body: {
        tier: "pro",
        billing: "monthly",
        email: "newmgr@test.com",
        fullName: "New Manager",
        promo: "FREE100",
      },
    });
    const res = await signupIntent(req);
    const { status, data } = await parseJsonResponse<{ sessionId: string }>(res);
    expect(status).toBe(200);
    expect(data.sessionId).toMatch(/^axis_intent_/);
    expect(insert).toHaveBeenCalled();
  });

  it("creates free tier signup without promo", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [] }),
        }),
        insert,
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/manager/signup-intent", {
      method: "POST",
      body: {
        tier: "free",
        billing: "monthly",
        email: "freemgr@test.com",
        fullName: "Free Manager",
      },
    });
    const res = await signupIntent(req);
    expect(res.status).toBe(200);
  });

});
