import { beforeEach, describe, expect, it, vi } from "vitest";

const authUser = vi.hoisted(() => vi.fn());
const businessAccess = vi.hoisted(() => vi.fn());
const serviceDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: authUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: businessAccess,
}));
vi.mock("@/lib/auth/workspace-add-property.server", () => ({
  resolveCreateListingOwner: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));

import { GET, POST } from "@/app/api/property-records/route";

beforeEach(() => {
  vi.clearAllMocks();
  authUser.mockResolvedValue({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } });
  serviceDb.mockReturnValue({ from: vi.fn() });
});

describe("classified property-record service boundary", () => {
  it.each(["suspended", "expired", "flag-off"]) ("denies a %s session before service-role reads or writes", async (state) => {
    const db = serviceDb();
    serviceDb.mockReturnValue(db);
    businessAccess.mockResolvedValue({ kind: "denied", state });

    const read = await GET();
    const write = await POST(new Request("https://prop-lane.test/api/property-records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", id: "record-1" }),
    }));

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("passes a normal session through the classified-account gate", async () => {
    serviceDb.mockReturnValue({
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    });
    businessAccess.mockResolvedValue({ kind: "normal" });

    const response = await POST(new Request("https://prop-lane.test/api/property-records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", id: "record-1" }),
    }));

    expect(response.status).toBe(403);
    expect(businessAccess).toHaveBeenCalledOnce();
  });
});
