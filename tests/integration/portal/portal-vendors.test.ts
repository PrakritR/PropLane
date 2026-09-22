import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { GET, POST } from "@/app/api/portal-vendors/route";

function noAcceptedLinks() {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    data: [],
    error: null,
  };
}

describe("/api/portal-vendors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "mgr-a", email: "a@test.com", user_metadata: { role: "manager" } } },
        }),
      },
    } as never);
  });

  it("GET returns own vendors plus shared vendors from other managers", async () => {
    const ownResult = {
      data: [{ row_data: { id: "v1", name: "Mine", managerUserId: "mgr-a", active: true } }],
      error: null,
    };
    const ownChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue(ownResult),
    };
    const sharedResult = {
      data: [
        {
          manager_user_id: "mgr-b",
          row_data: { id: "v2", name: "Shared", sharedWithManagers: true, active: true },
        },
      ],
      error: null,
    };
    const sharedChain = {
      select: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(sharedResult),
    };
    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
    };

    let vendorQuery = 0;
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") return profileChain;
        if (table === "account_link_invites") return noAcceptedLinks();
        if (table === "manager_vendor_records") {
          vendorQuery += 1;
          return vendorQuery === 1 ? ownChain : sharedChain;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const res = await GET(new Request("http://localhost/api/portal-vendors"));
    const { status, data } = await parseJsonResponse<{ rows?: { id: string; managerUserId?: string }[] }>(res);
    expect(status).toBe(200);
    expect(data.rows?.map((r) => r.id)).toEqual(["v1", "v2"]);
    expect(data.rows?.find((r) => r.id === "v2")?.managerUserId).toBe("mgr-b");
  });

  it("GET as a co-manager granted `services` on ONE of an owner's houses returns only vendors that serve that house — never the owner's whole directory", async () => {
    const ownResult = { data: [], error: null }; // the delegate owns nothing itself
    const ownChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue(ownResult),
    };
    const linkRows = {
      data: [
        {
          inviter_user_id: "owner-x",
          assigned_property_ids: ["house-1", "house-2", "house-3"],
          property_co_manager_permissions: { "house-1": { services: { read: true } } },
          house_scope: "selected",
        },
      ],
      error: null,
    };
    const linkedChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          { manager_user_id: "owner-x", row_data: { id: "v-h1", name: "House 1 vendor", propertyIds: ["house-1"], active: true } },
          { manager_user_id: "owner-x", row_data: { id: "v-h2", name: "House 2 vendor", propertyIds: ["house-2"], active: true } },
          { manager_user_id: "owner-x", row_data: { id: "v-all", name: "Portfolio vendor", propertyIds: [], active: true } },
        ],
        error: null,
      }),
    };
    const sharedChain = {
      select: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
    };
    // `linkedOwnerScopeForModule` reads the viewer's own email (maybeSingle)
    // and the inviter's email (in) off the same table — both plain, non-sandbox
    // addresses so the cross-sandbox guard never fires in this fixture.
    const emailChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { email: "delegate@test.com" }, error: null }),
      in: vi.fn().mockResolvedValue({
        data: [{ id: "owner-x", email: "owner@test.com" }],
        error: null,
      }),
    };

    let vendorQuery = 0;
    let profileQuery = 0;
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          profileQuery += 1;
          return profileQuery === 1 ? profileChain : emailChain;
        }
        if (table === "account_link_invites") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), then: (resolve: (v: unknown) => unknown) => Promise.resolve(linkRows).then(resolve) };
        if (table === "manager_vendor_records") {
          vendorQuery += 1;
          if (vendorQuery === 1) return ownChain;
          if (vendorQuery === 2) return linkedChain;
          return sharedChain;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const res = await GET(new Request("http://localhost/api/portal-vendors"));
    const { status, data } = await parseJsonResponse<{ rows?: { id: string }[] }>(res);
    expect(status).toBe(200);
    const ids = data.rows?.map((r) => r.id) ?? [];
    expect(ids).toContain("v-h1");
    expect(ids).toContain("v-all");
    expect(ids).not.toContain("v-h2");
  });

  it("GET as a co-manager with an empty grant on the owner's houses returns no linked vendors", async () => {
    const ownChain = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const sharedChain = {
      select: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
    };
    const emailChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { email: "delegate@test.com" }, error: null }),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const linkRows = {
      data: [
        {
          inviter_user_id: "owner-x",
          assigned_property_ids: ["house-1"],
          property_co_manager_permissions: {},
          house_scope: "selected",
        },
      ],
      error: null,
    };

    // The two manager_vendor_records calls are own, then shared — no
    // linked-owner call happens at all because the grant is empty
    // (`linkedOwnerScopeForModule` returns zero qualifying owners).
    let profileQuery = 0;
    let vendorQuery = 0;
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          profileQuery += 1;
          return profileQuery === 1 ? profileChain : emailChain;
        }
        if (table === "account_link_invites") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), then: (resolve: (v: unknown) => unknown) => Promise.resolve(linkRows).then(resolve) };
        if (table === "manager_vendor_records") {
          vendorQuery += 1;
          return vendorQuery === 1 ? ownChain : sharedChain;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const res = await GET(new Request("http://localhost/api/portal-vendors"));
    const { status, data } = await parseJsonResponse<{ rows?: { id: string }[] }>(res);
    expect(status).toBe(200);
    expect(data.rows ?? []).toEqual([]);
  });

  it("POST upsert rejects editing another manager vendor", async () => {
    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
    };
    // The route decides ownership from the STORED row (select ... .in("id", ids)),
    // never from the client-supplied managerUserId.
    const ownerLookup = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [{ id: "v-other", manager_user_id: "mgr-b" }], error: null }),
    };
    const acceptedLinks = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn(),
    };
    acceptedLinks.eq.mockReturnValueOnce(acceptedLinks).mockResolvedValueOnce({ data: [], error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") return profileChain;
        if (table === "account_link_invites") return acceptedLinks;
        if (table === "manager_vendor_records") return ownerLookup;
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/portal-vendors", {
      method: "POST",
      body: {
        action: "upsert",
        row: {
          id: "v-other",
          managerUserId: "mgr-b",
          name: "Not mine",
          trade: "",
          phone: "",
          email: "",
          notes: "",
          active: true,
        },
      },
    });
    const res = await POST(req);
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);
    expect(status).toBe(403);
    expect(data.error).toMatch(/another manager/i);
    expect(acceptedLinks.eq).toHaveBeenCalledWith("status", "accepted");
    expect(acceptedLinks.eq).toHaveBeenCalledWith("invitee_user_id", "mgr-a");
  });

  it("POST upsert persists sharedWithManagers on own vendor", async () => {
    const savedRow = {
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "v-share" }, error: null }),
    };
    const insert = vi.fn().mockReturnValue(savedRow);
    const profileChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") return profileChain;
        if (table === "account_link_invites") return noAcceptedLinks();
        if (table === "manager_vendor_records")
          return {
            // Ownership pre-read: no stored row → the caller becomes the owner.
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert,
          };
        throw new Error(`Unexpected table ${table}`);
      }),
    } as never);

    const req = jsonRequest("http://localhost/api/portal-vendors", {
      method: "POST",
      body: {
        action: "upsert",
        row: {
          id: "v-share",
          managerUserId: "mgr-a",
          name: "Shared Vendor",
          trade: "Plumbing",
          phone: "",
          email: "",
          notes: "",
          active: true,
          sharedWithManagers: true,
        },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "v-share",
        manager_user_id: "mgr-a",
        row_data: expect.objectContaining({ sharedWithManagers: true, name: "Shared Vendor" }),
      }),
    );
  });
});
