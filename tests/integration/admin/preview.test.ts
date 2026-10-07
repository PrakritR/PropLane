import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn(),
}));

import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { POST as adminPreview } from "@/app/api/admin/preview/route";

function request() {
  return new Request("http://localhost/api/admin/preview", {
    method: "POST",
    body: JSON.stringify({
      targetUserId: "11111111-1111-4111-8111-111111111111",
      portal: "manager",
      reason: "Customer cannot see rent",
    }),
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
  });
}

describe("POST /api/admin/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROPLANE_VIEW_AS_SECRET = "p".repeat(40);
    process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = "u1";
  });

  it("rejects non-admin users, even when allowlisted", async () => {
    vi.mocked(createRealIdentitySupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
    } as never);
    vi.mocked(isAdminUser).mockResolvedValue(false);

    const res = await adminPreview(request());
    expect(res.status).toBe(403);
  });

  it("rejects an admin who is not on the operator allowlist", async () => {
    process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = "someone-else";
    vi.mocked(createRealIdentitySupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
    } as never);
    vi.mocked(isAdminUser).mockResolvedValue(true);

    const res = await adminPreview(request());
    expect(res.status).toBe(403);
  });
});
