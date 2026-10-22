import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

// The route reads the selected-workspace cookie through `next/headers` and only touches the
// service-role client when one is set. A plain `Request` never enters a Next request scope, so
// both have to be stood in for here.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(),
  hasRole: vi.fn(),
  isPortalRoleReachable: vi.fn(),
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPortalAccessContext, hasRole, isPortalRoleReachable } from "@/lib/auth/portal-access";
import { POST as setActivePortal } from "@/app/api/auth/set-active-portal/route";

describe("POST /api/auth/set-active-portal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const req = jsonRequest("http://localhost/api/auth/set-active-portal", {
      method: "POST",
      body: { role: "manager" },
    });
    const res = await setActivePortal(req);
    expect(res.status).toBe(401);
  });

  it("sets active portal cookie for authorized user", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
    } as never);
    vi.mocked(getPortalAccessContext).mockResolvedValue({ roles: ["manager", "resident"] } as never);
    vi.mocked(hasRole).mockReturnValue(true);
    vi.mocked(isPortalRoleReachable).mockReturnValue(true);

    const req = jsonRequest("http://localhost/api/auth/set-active-portal", {
      method: "POST",
      body: { role: "manager" },
    });
    const res = await setActivePortal(req);
    const { status, data } = await parseJsonResponse<{ ok: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("axis_active_portal");
  });
});
