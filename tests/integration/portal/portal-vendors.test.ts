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
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "profiles") return profileChain;
        if (table === "account_link_invites") return noAcceptedLinks();
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
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        manager_user_id: "mgr-a",
        row_data: expect.objectContaining({ sharedWithManagers: true, name: "Shared Vendor" }),
      }),
    );
  });
});
