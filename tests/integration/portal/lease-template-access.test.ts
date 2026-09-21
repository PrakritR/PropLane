import { beforeEach, describe, expect, it, vi } from "vitest";

// The route resolves the caller itself (it must judge a multi-role account on
// each relationship it holds, not on one preferred portal role), so the session
// and the co-manager/resident scope resolvers are mocked and the route's own
// authorization logic is what runs.
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedPropertyIdsForModule: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({
  resolveResidentFilingScope: vi.fn(),
  residentHasApprovedResidency: vi.fn(),
}));
vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { leaseTemplateUrlForPath } from "@/lib/lease-template-storage";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { residentHasApprovedResidency, resolveResidentFilingScope } from "@/lib/resident-manager-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { GET, DELETE } from "@/app/api/portal/lease-template/route";

const OWNER = "b5809cf3-dcff-4e46-a0cc-5dcc53bc8910";
const OTHER = "f707ad54-3d2f-4217-804d-3de84e7b61ef";
const PATH = `${OWNER}/1753000000000-ab12cd.pdf`;
const PDF = Buffer.from("%PDF-1.7 lease");

/** The listing whose submission references the template under test. */
const PROPERTY_ROW = {
  id: "mgr-1",
  manager_user_id: OWNER,
  property_data: { listingSubmission: { leaseTemplateDocUrl: leaseTemplateUrlForPath(PATH) } },
};

/**
 * Supabase-shaped mock. The route asks three distinct questions, so the mock
 * answers them separately: properties the caller OWNS (`eq manager_user_id`),
 * properties fetched by id (co-manager links and the resident's own), and lease
 * pipeline rows. A `.eq()` / `.in()` result is both awaitable and chainable, the
 * way the real builder is.
 */
function mockDb({
  owned = [] as unknown[],
  byId = [PROPERTY_ROW] as unknown[],
  leases = [] as unknown[],
} = {}) {
  const removed: string[][] = [];
  const downloaded: string[] = [];
  const result = (data: unknown[]) => {
    const value = { data, error: null };
    return {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
      maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
    };
  };
  return {
    removed,
    downloaded,
    client: {
      from: (table: string) => {
        if (table === "profiles") return { select: () => ({ eq: () => result([{ email: "r@example.com" }]) }) };
        if (table === "portal_lease_pipeline_records") return { select: () => ({ eq: () => result(leases) }) };
        return {
          select: () => ({
            eq: () => result(owned),
            in: () => result(byId),
          }),
        };
      },
      storage: {
        from: () => ({
          download: async (path: string) => {
            downloaded.push(path);
            return { data: new Blob([PDF]), error: null };
          },
          remove: async (paths: string[]) => {
            removed.push(paths);
            return { error: null };
          },
        }),
      },
    },
  };
}

function signedInAs(userId: string | null) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId, email: "r@example.com" } : null } }) },
  } as never);
  vi.mocked(getReportsAuthContext).mockImplementation(async () => userId ? ({
    db: createSupabaseServiceRoleClient(),
    userId,
    email: "r@example.com",
    role: "manager",
  }) as never : null);
}

function get(path: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/portal/lease-template?path=${encodeURIComponent(path)}`));
}

describe("GET /api/portal/lease-template", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(linkedPropertyIdsForModule).mockResolvedValue(new Set());
    vi.mocked(resolveResidentFilingScope).mockResolvedValue(null);
    vi.mocked(residentHasApprovedResidency).mockResolvedValue(true);
  });

  it("denies an anonymous caller", async () => {
    signedInAs(null);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(mockDb().client as never);
    expect((await get(PATH)).status).toBe(404);
  });

  it("serves the owning manager", async () => {
    signedInAs(OWNER);
    const db = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db.client as never);

    const res = await get(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(db.downloaded).toEqual([PATH]);
  });

  it("serves the resident whose linked property references the template", async () => {
    signedInAs(OTHER);
    vi.mocked(resolveResidentFilingScope).mockResolvedValue({ managerUserId: OWNER, propertyId: "mgr-1" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(mockDb().client as never);

    expect((await get(PATH)).status).toBe(200);
  });

  it("denies a resident whose property does NOT reference the template", async () => {
    signedInAs(OTHER);
    vi.mocked(resolveResidentFilingScope).mockResolvedValue({ managerUserId: OWNER, propertyId: "mgr-2" });
    // Their property points at a different object.
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({
        byId: [
          { property_data: { listingSubmission: { leaseTemplateDocUrl: leaseTemplateUrlForPath(`${OWNER}/other.pdf`) } } },
        ],
      }).client as never,
    );

    expect((await get(PATH)).status).toBe(404);
  });

  it("denies a PENDING applicant, who is not yet a resident", async () => {
    // resolveResidentFilingScope falls back to unapproved rows when a person has
    // no approved residency, so anyone who applied to a live listing would
    // otherwise inherit the resident grant.
    signedInAs(OTHER);
    vi.mocked(resolveResidentFilingScope).mockResolvedValue({ managerUserId: OWNER, propertyId: "mgr-1" });
    vi.mocked(residentHasApprovedResidency).mockResolvedValue(false);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(mockDb().client as never);

    expect((await get(PATH)).status).toBe(404);
  });

  it("denies a different manager with no relationship to the property", async () => {
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(mockDb({ byId: [] }).client as never);
    expect((await get(PATH)).status).toBe(404);
  });

  it("serves a co-manager assigned the property that references it", async () => {
    signedInAs(OTHER);
    vi.mocked(linkedPropertyIdsForModule).mockResolvedValue(new Set(["mgr-1"]));
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(mockDb().client as never);
    expect((await get(PATH)).status).toBe(200);
  });

  it("serves the property's OWNER even when a co-manager uploaded it", async () => {
    // POST always writes into the uploader's folder, so a co-manager's upload
    // lands outside the owner's folder while the URL is stored on the owner's
    // listing. Ownership is re-derived from manager_user_id, not the folder.
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({ owned: [PROPERTY_ROW], byId: [] }).client as never,
    );
    expect((await get(PATH)).status).toBe(200);
  });

  it("still serves a resident whose signed lease embeds a template the listing no longer references", async () => {
    // Replacing a property's template leaves every already-generated lease
    // pointing at the old object; the resident who signed it must not 404.
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({
        byId: [],
        leases: [
          {
            manager_user_id: OWNER,
            property_id: "mgr-1",
            row_data: { generatedHtml: `<object data="${leaseTemplateUrlForPath(PATH)}">` },
          },
        ],
      }).client as never,
    );
    expect((await get(PATH)).status).toBe(200);
  });

  it("denies a manager who planted another manager's path on their OWN listing", async () => {
    // `leaseTemplateDocUrl` is a manager-editable blob field and the folder id
    // is public (`managerUserId` ships in the listing payload), so "a property I
    // own references this path" cannot be authorization on its own.
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({
        owned: [
          {
            id: "mgr-attacker",
            manager_user_id: OTHER,
            property_data: { listingSubmission: { leaseTemplateDocUrl: leaseTemplateUrlForPath(PATH) } },
          },
        ],
        byId: [],
      }).client as never,
    );

    expect((await get(PATH)).status).toBe(404);
  });

  it("denies a manager who planted another manager's path in their OWN lease row", async () => {
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({
        owned: [],
        byId: [],
        leases: [
          {
            manager_user_id: OTHER,
            property_id: "mgr-attacker",
            row_data: { generatedHtml: `<object data="${leaseTemplateUrlForPath(PATH)}">` },
          },
        ],
      }).client as never,
    );

    expect((await get(PATH)).status).toBe(404);
  });

  it("denies when an unrelated lease row exists but embeds a different template", async () => {
    signedInAs(OTHER);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      mockDb({
        byId: [],
        leases: [
          {
            manager_user_id: OWNER,
            property_id: "mgr-1",
            row_data: { generatedHtml: `<object data="${leaseTemplateUrlForPath(`${OWNER}/other.pdf`)}">` },
          },
        ],
      }).client as never,
    );
    expect((await get(PATH)).status).toBe(404);
  });

  it("rejects a traversal path before touching storage", async () => {
    signedInAs(OWNER);
    const db = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db.client as never);

    expect((await get(`${OWNER}/../../other/lease.pdf`)).status).toBe(404);
    expect(db.downloaded).toEqual([]);
  });
});

describe("DELETE /api/portal/lease-template", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes only paths inside the caller's own folder", async () => {
    signedInAs(OWNER);
    const db = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db.client as never);

    const res = await DELETE(
      new Request("http://localhost/api/portal/lease-template", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [PATH, `${OTHER}/victim.pdf`] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(db.removed).toEqual([[PATH]]);
  });
});
