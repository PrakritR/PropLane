/**
 * W004: `GET /api/property-records` returned every property the manager
 * owns, across EVERY workspace, regardless of which one is active — the raw
 * payload (full address, access codes) always carried the whole portfolio.
 * This proves the active-workspace predicate now narrows the owned-rows
 * branch, using the three rules every workspace-scoped surface shares:
 * `null` (no workspaces / load failure) never narrows; a resolved array
 * restricts to those houses; an empty array (the workspace holds none)
 * yields nothing.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oversightTranscript } from "./support/oversight-transcript";

const getUser = vi.fn();
const isAdminUser = vi.fn();
/** `null` = not narrowing (matches `activeWorkspacePropertyScope`'s own contract). */
let ACTIVE_WORKSPACE_SCOPE: string[] | null;
let PROPERTIES: { id: string; manager_user_id: string }[];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => ACTIVE_WORKSPACE_SCOPE),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn().mockResolvedValue({ kind: "normal" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

const MANAGER = "mgr-1";

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
        maybeSingle: async () => (table === "profiles" ? { data: { email: "manager@example.com" }, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown[] = [];
          if (table === "manager_property_records" && builder.eqCol === "manager_user_id") {
            data = PROPERTIES.filter((p) => p.manager_user_id === builder.eqVal).map(toRow);
          } else if (table === "manager_property_records") {
            // The admin branch's `baseQuery` runs with no `.eq()` filter at all.
            data = PROPERTIES.map(toRow);
          } else if (table === "account_link_invites") {
            data = [];
          } else if (table === "profiles") {
            data = [{ id: MANAGER, email: "manager@example.com" }];
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function toRow(p: { id: string; manager_user_id: string }) {
  return { id: p.id, manager_user_id: p.manager_user_id, status: "live", row_data: {}, property_data: { id: p.id, adminPublishLive: true }, edit_request_note: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  getUser.mockResolvedValue({ data: { user: { id: MANAGER, email: "manager@example.com" } } });
  PROPERTIES = [
    { id: "house-a", manager_user_id: MANAGER },
    { id: "house-b", manager_user_id: MANAGER },
  ];
  ACTIVE_WORKSPACE_SCOPE = null;
});

describe("GET /api/property-records — active-workspace guard", () => {
  it("returns every owned property when the workspace load does not narrow", async () => {
    ACTIVE_WORKSPACE_SCOPE = null;
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET();
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    expect(body.snapshot.extrasByUser[MANAGER]).toHaveLength(2);
  });

  it("narrows to only workspace A's house while A is active", async () => {
    ACTIVE_WORKSPACE_SCOPE = ["house-a"];
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET();
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    const ids = (body.snapshot.extrasByUser[MANAGER] as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["house-a"]);
  });

  it("switching the active workspace to B's house now excludes A", async () => {
    ACTIVE_WORKSPACE_SCOPE = ["house-b"];
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET();
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    const ids = (body.snapshot.extrasByUser[MANAGER] as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["house-b"]);
  });

  it("an empty active workspace returns none of the owned properties", async () => {
    ACTIVE_WORKSPACE_SCOPE = [];
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET();
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    expect(body.snapshot.extrasByUser[MANAGER] ?? []).toHaveLength(0);
  });

  it("an admin in oversight is never narrowed by a manager's workspace", async () => {
    isAdminUser.mockResolvedValue(true);
    ACTIVE_WORKSPACE_SCOPE = ["house-a"];
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET(new Request("http://localhost/api/property-records?oversight=admin"));
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, unknown[]> } };
    // Admin path returns everything under `manager_user_id`'s own bucket
    // (both houses share MANAGER as owner in this fixture).
    expect(body.snapshot.extrasByUser[MANAGER]).toHaveLength(2);
  });
});

describe("GET /api/property-records — admin oversight is explicit", () => {
  const transcript = oversightTranscript("oversight-property-records.txt", [
    "GET /api/property-records — the manager portal's houses read.",
    "Fixture: house-admin is the viewer's (a platform admin who also manages); house-other is another owner's.",
  ]);
  afterAll(() => transcript.write());

  beforeEach(() => {
    // The fixture db keys the viewer's own rows on MANAGER; here that account is also a platform admin.
    getUser.mockResolvedValue({ data: { user: { id: MANAGER, email: "manager@example.com" } } });
    PROPERTIES = [
      { id: "house-admin", manager_user_id: MANAGER },
      { id: "house-other", manager_user_id: "owner-other" },
    ];
  });
  const houses = async (query = "", viewer = "platform admin + manager") => {
    const { GET } = await import("@/app/api/property-records/route");
    const res = await GET(new Request(`http://localhost/api/property-records${query}`));
    const body = (await res.json()) as { snapshot: { extrasByUser: Record<string, { id?: string }[]> } };
    const rows = Object.values(body.snapshot.extrasByUser).flat();
    transcript.record("/api/property-records", query, viewer, res.status, rows.map((row) => String(row.id)).sort());
    return rows.length;
  };

  it("an admin in their own manager portal reads only their own houses", async () => {
    isAdminUser.mockResolvedValue(true);
    expect(await houses()).toBe(1);
  });

  it("an admin page that asks for oversight reads every owner's houses", async () => {
    isAdminUser.mockResolvedValue(true);
    expect(await houses("?oversight=admin")).toBe(2);
  });

  it("a non-admin sending the oversight parameter is still scoped", async () => {
    isAdminUser.mockResolvedValue(false);
    expect(await houses("?oversight=admin", "manager")).toBe(1);
  });

  it("a different oversight value is not oversight", async () => {
    isAdminUser.mockResolvedValue(true);
    expect(await houses("?oversight=all")).toBe(1);
  });
});
