/**
 * `GET /api/property-records`'s co-managed union (Class B) added every house
 * from `assigned_property_ids` with NO module check — a co-manager assigned a
 * property with an EMPTY permission map still saw its full address, access
 * info and fee-waiver code in the pipeline list. A house now appears only
 * when `properties` is granted at read (docs/agents/co-manager-access.md
 * "Empty used to mean FULL"). Companion to
 * `tests/unit/property-records-co-manager-grant.test.ts`, which covers the
 * write side.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isAdminUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

const route = await import("@/app/api/property-records/route");

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

let linkRows: LinkRow[] = [];

function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> & { eqCol?: string; eqVal?: string } = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: string) => {
          builder.eqCol = column;
          builder.eqVal = value;
          return builder;
        },
        in: () => builder,
        maybeSingle: async () => {
          if (table === "profiles") return { data: { email: "delegate@example.com" }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown[] = [];
          const linkedPropertyRow = {
            id: PROPERTY,
            manager_user_id: OWNER,
            status: "live",
            row_data: {},
            property_data: { id: PROPERTY, address: "123 Main St", adminPublishLive: true },
            edit_request_note: null,
          };
          if (table === "account_link_invites") {
            data = linkRows;
          } else if (table === "profiles") {
            data = [
              { id: OWNER, email: "owner@example.com" },
              { id: DELEGATE, email: "delegate@example.com" },
            ];
          } else if (table === "manager_property_records") {
            if (builder.eqCol === "manager_user_id") {
              // The direct-ownership query: only the actual owner sees the row.
              data = builder.eqVal === OWNER ? [linkedPropertyRow] : [];
            } else {
              // The co-managed union's `.in("id", [...linkedPropertyIds])` query.
              data = [linkedPropertyRow];
            }
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function grant(permissions: unknown): LinkRow[] {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: permissions,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  linkRows = [];
  isAdminUser.mockResolvedValue(false);
  getUser.mockResolvedValue({ data: { user: { id: DELEGATE, email: "delegate@example.com" } } });
});

describe("GET /api/property-records — co-managed union module gate", () => {
  it("omits a house assigned with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedPropertyIds: string[] };
    expect(body.linkedPropertyIds).toEqual([]);
  });

  it("omits a house granted only a DIFFERENT module", async () => {
    linkRows = grant({ [PROPERTY]: { applications: { read: true, edit: true } } });
    const res = await route.GET();
    const body = (await res.json()) as { linkedPropertyIds: string[] };
    expect(body.linkedPropertyIds).toEqual([]);
  });

  it("includes a house granted `properties` at read", async () => {
    linkRows = grant({ [PROPERTY]: { properties: { read: true } } });
    const res = await route.GET();
    const body = (await res.json()) as { linkedPropertyIds: string[]; snapshot: { extrasByUser: Record<string, unknown[]> } };
    expect(body.linkedPropertyIds).toEqual([PROPERTY]);
    expect(body.snapshot.extrasByUser[OWNER]).toHaveLength(1);
  });

  it("the owner sees their own property with no link rows at all", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "owner@example.com" } } });
    linkRows = [];
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    expect(body.snapshot.extrasByUser[OWNER]).toHaveLength(1);
  });
});
