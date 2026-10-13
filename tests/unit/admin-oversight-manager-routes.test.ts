/**
 * A platform admin who also manages a workspace used to see OTHER owners' records in their own
 * manager portal, because these GET routes gave any admin an all-owners read with no explicit
 * parameter. The rule (same as `GET /api/manager-applications`): every caller gets the
 * manager-scoped read; the all-owners read is served only when the request sends
 * `?oversight=admin` AND the server confirms the admin role.
 *
 * Per route: an admin without the parameter reads only their own rows; with the parameter, every
 * owner's; a non-admin sending the parameter is still scoped. Property records, the lease pipeline
 * and schedule records carry the same three cases in their own route test files (where their
 * heavier fixtures live).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const ME = "mgr-admin";
const OTHER = "mgr-other";

const hoisted = vi.hoisted(() => ({
  admin: true,
  profileRole: "manager",
  tables: {} as Record<string, Row[]>,
  tourExport: vi.fn(async () => [] as unknown[]),
  writes: [] as Array<{ table: string; op: string; record: Row | null }>,
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => hoisted.admin) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: ME, email: "viewer@test.local", user_metadata: {} } }, error: null }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/auth/resident-role-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/resident-role-access")>()),
  resolveResidentScopedActorRole: vi.fn(async () => "manager"),
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: vi.fn(async () => false) }));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  shouldRunScopeRepair: vi.fn(() => false),
  repairServiceRequestScopesForManager: vi.fn(async () => undefined),
  repairWorkOrderScopesForManager: vi.fn(async () => undefined),
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: vi.fn(async () => null) }));
vi.mock("@/lib/workspaces/row-scope.server", () => ({
  resolveActiveWorkspaceRowScope: vi.fn(async () => ({ propertyIds: null, includeUntagged: true })),
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>()),
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
  linkedOwnerScopeForModule: vi.fn(async () => ({
    ownerIds: new Set<string>(),
    propertyIds: new Set<string>(),
    propertyIdsByOwner: new Map<string, Set<string>>(),
  })),
  managerScopedPropertyIds: vi.fn(async () => new Set<string>()),
  resolveManagerWorkspaceRowScope: vi.fn(async () => ({ propertyIds: null, untaggedOwnedVisible: true })),
  rowInWorkspaceScope: vi.fn(() => true),
  fetchRowsForManagerWithLinked: vi.fn(async (db: ReturnType<typeof makeDb>, table: string, userId: string) => {
    const { data } = await db.from(table).select("*").eq("manager_user_id", userId);
    return data ?? [];
  }),
}));
vi.mock("@/lib/work-order-manager-names.server", () => ({
  attachManagerNamesToWorkOrders: vi.fn(async (_db: unknown, rows: unknown[]) => rows),
}));
vi.mock("@/lib/work-order-vendor-offers.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-order-vendor-offers.server")>()),
  vendorDirectoryRowsById: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/work-order-bids.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/work-order-bids.server")>()),
  vendorNamesById: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({
    user: { id: ME, email: "viewer@test.local" },
    profile: { email: "viewer@test.local", role: hoisted.profileRole },
    roles: hoisted.admin ? ["admin", "manager"] : ["manager"],
    effectiveRole: null,
  }),
}));
vi.mock("@/lib/manager-tour-export.server", () => ({
  loadManagerTourExportRows: (...a: unknown[]) => hoisted.tourExport(...(a as [])),
  tourRowsToReportResult: () => ({ columns: [], rows: [] }),
}));
vi.mock("@/lib/reports/export/csv", () => ({ reportToCsv: () => "csv" }));
vi.mock("@/lib/reports/export/pdf", () => ({ reportToPdf: async () => new Uint8Array() }));

/** Chainable stub over `hoisted.tables`: eq / neq / in / is / or(eq clauses) / order / limit. */
function makeDb() {
  return {
    from(table: string) {
      const preds: Array<(row: Row) => boolean> = [];
      let writing: "delete" | null = null;
      const field = (row: Row, column: string): unknown => {
        if (column.includes("->>")) {
          const [col, key] = column.split("->>");
          return ((row[col!] as Row | undefined) ?? {})[key!];
        }
        return row[column];
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        gte: () => builder,
        eq(column: string, value: unknown) {
          preds.push((row) => String(field(row, column) ?? "") === String(value));
          return builder;
        },
        neq(column: string, value: unknown) {
          preds.push((row) => String(field(row, column) ?? "") !== String(value));
          return builder;
        },
        in(column: string, values: unknown[]) {
          preds.push((row) => values.map(String).includes(String(field(row, column) ?? "")));
          return builder;
        },
        is(column: string, value: unknown) {
          preds.push((row) => (field(row, column) ?? null) === value);
          return builder;
        },
        or(filter: string) {
          const clauses = filter.split(",").map((part) => part.split("."));
          preds.push((row) => clauses.some(([column, op, value]) => op === "eq" && String(row[column!] ?? "") === value));
          return builder;
        },
        upsert(record: Row) {
          hoisted.writes.push({ table, op: "upsert", record });
          return Promise.resolve({ error: null });
        },
        insert(record: Row) {
          hoisted.writes.push({ table, op: "insert", record });
          return builder;
        },
        update(record: Row) {
          hoisted.writes.push({ table, op: "update", record });
          return builder;
        },
        delete() {
          writing = "delete";
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "profiles"
                ? { role: hoisted.profileRole, email: "viewer@test.local" }
                : (rowsFor()[0] ?? null),
            error: null,
          }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (writing === "delete") {
            for (const row of rowsFor()) hoisted.writes.push({ table, op: "delete", record: row });
          }
          return Promise.resolve({ data: rowsFor(), error: null }).then(resolve);
        },
      };
      const rowsFor = () => (hoisted.tables[table] ?? []).filter((row) => preds.every((pred) => pred(row)));
      return builder;
    },
  };
}

function get(path: string, query: string) {
  return new Request(`https://example.test${path}${query}`);
}

beforeEach(() => {
  vi.resetModules();
  hoisted.admin = true;
  hoisted.profileRole = "manager";
  hoisted.tables = {
    profiles: [],
    portal_service_request_records: [
      { id: "sr-mine", manager_user_id: ME, row_data: { id: "sr-mine" }, updated_at: "2026-01-01" },
      { id: "sr-other", manager_user_id: OTHER, row_data: { id: "sr-other" }, updated_at: "2026-01-01" },
    ],
    portal_work_order_records: [
      { id: "wo-mine", manager_user_id: ME, row_data: { id: "wo-mine" }, updated_at: "2026-01-01" },
      { id: "wo-other", manager_user_id: OTHER, row_data: { id: "wo-other" }, updated_at: "2026-01-01" },
    ],
    manager_promotion_records: [
      { id: "pr-mine", manager_user_id: ME, row_data: { id: "pr-mine" }, updated_at: "2026-01-01" },
      { id: "pr-other", manager_user_id: OTHER, row_data: { id: "pr-other" }, updated_at: "2026-01-01" },
    ],
    manager_vendor_records: [
      { id: "v-mine", manager_user_id: ME, row_data: { id: "v-mine", name: "Mine" }, updated_at: "2026-01-01" },
      { id: "v-other", manager_user_id: OTHER, row_data: { id: "v-other", name: "Other" }, updated_at: "2026-01-01" },
    ],
    portal_household_charge_records: [
      { id: "ch-mine", manager_user_id: ME, row_data: { id: "ch-mine" }, updated_at: "2026-01-01" },
      { id: "ch-other", manager_user_id: OTHER, row_data: { id: "ch-other" }, updated_at: "2026-01-01" },
    ],
    portal_recurring_rent_profile_records: [],
    profile_roles: [],
    work_order_vendor_offers: [
      { id: "of-mine", work_order_id: "wo-mine", manager_user_id: ME, vendor_directory_id: "vd", status: "sent", created_at: "2026-01-01" },
      { id: "of-other", work_order_id: "wo-other", manager_user_id: OTHER, vendor_directory_id: "vd", status: "sent", created_at: "2026-01-01" },
    ],
    work_order_bids: [
      { id: "bid-mine", work_order_id: "wo-mine", manager_user_id: ME, amount_cents: 1, created_at: "2026-01-01", updated_at: "2026-01-01" },
      { id: "bid-other", work_order_id: "wo-other", manager_user_id: OTHER, amount_cents: 2, created_at: "2026-01-01", updated_at: "2026-01-01" },
    ],
  };
  hoisted.tourExport.mockClear();
  hoisted.writes = [];
});

type Case = {
  name: string;
  path: string;
  route: string;
  ids: (body: Record<string, unknown>) => string[];
  mine: string[];
  all: string[];
};

const idsOf = (rows: unknown, key = "id") => ((rows as Row[] | undefined) ?? []).map((row) => String(row[key])).sort();

const CASES: Case[] = [
  { name: "portal-service-requests", path: "/api/portal-service-requests", route: "@/app/api/portal-service-requests/route", ids: (b) => idsOf(b.rows), mine: ["sr-mine"], all: ["sr-mine", "sr-other"] },
  { name: "portal-work-orders", path: "/api/portal-work-orders", route: "@/app/api/portal-work-orders/route", ids: (b) => idsOf(b.rows), mine: ["wo-mine"], all: ["wo-mine", "wo-other"] },
  { name: "portal-promotions", path: "/api/portal-promotions", route: "@/app/api/portal-promotions/route", ids: (b) => idsOf(b.rows), mine: ["pr-mine"], all: ["pr-mine", "pr-other"] },
  { name: "portal-vendors", path: "/api/portal-vendors", route: "@/app/api/portal-vendors/route", ids: (b) => idsOf(b.rows), mine: ["v-mine"], all: ["v-mine", "v-other"] },
  { name: "portal-household-charges", path: "/api/portal-household-charges", route: "@/app/api/portal-household-charges/route", ids: (b) => idsOf(b.charges), mine: ["ch-mine"], all: ["ch-mine", "ch-other"] },
  { name: "portal/work-order-vendor-offers", path: "/api/portal/work-order-vendor-offers", route: "@/app/api/portal/work-order-vendor-offers/route", ids: (b) => idsOf(b.offers), mine: ["of-mine"], all: ["of-mine", "of-other"] },
  { name: "portal/work-order-bids", path: "/api/portal/work-order-bids", route: "@/app/api/portal/work-order-bids/route", ids: (b) => idsOf(b.bids), mine: ["bid-mine"], all: ["bid-mine", "bid-other"] },
];

/** Real request → real response lines, written out as a reviewer-readable transcript. */
const transcript: string[] = [];

async function read(c: Case, query: string): Promise<string[]> {
  const { GET } = (await import(/* @vite-ignore */ c.route)) as { GET: (req: Request) => Promise<Response> };
  const res = await GET(get(c.path, query));
  expect(res.status).toBe(200);
  const ids = c.ids((await res.json()) as Record<string, unknown>);
  transcript.push(
    `GET ${c.path}${query}`.padEnd(62) +
      `(viewer: ${hoisted.admin ? "platform admin + manager" : "manager"})\n` +
      `  ${res.status} rows: ${JSON.stringify(ids)}`,
  );
  return ids;
}

afterAll(() => {
  const out = process.env.EVIDENCE_DIR ?? join(tmpdir(), "proplane-comms-isolation-evidence");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "manager-portal-routes-oversight.txt"),
    [
      "Manager-portal GET routes — the all-owners read is served only for ?oversight=admin from a",
      "server-confirmed admin. Fixture: every table holds one row owned by the viewer (-mine) and",
      "one owned by a different manager (-other).",
      "",
      ...transcript,
      "",
    ].join("\n"),
  );
});

describe.each(CASES)("GET $name — admin oversight is explicit", (c) => {
  it("an admin in their own manager portal reads only their own rows", async () => {
    expect(await read(c, "")).toEqual(c.mine);
  });

  it("an admin page that asks for oversight reads every owner's rows", async () => {
    expect(await read(c, "?oversight=admin")).toEqual(c.all);
  });

  it("a non-admin sending the oversight parameter is still scoped", async () => {
    hoisted.admin = false;
    expect(await read(c, "?oversight=admin")).toEqual(c.mine);
  });

  it("a different oversight value is not oversight", async () => {
    expect(await read(c, "?oversight=all")).toEqual(c.mine);
  });
});

describe("GET portal/tours-export — admin oversight is explicit", () => {
  const roleSent = async (query: string) => {
    const { GET } = await import("@/app/api/portal/tours-export/route");
    const res = await GET(get("/api/portal/tours-export", query));
    expect(res.status).toBe(200);
    const args = hoisted.tourExport.mock.calls.at(-1) as unknown as [{ user: { role: string; roles: string[] } }];
    return args[0].user;
  };

  it("an admin in their own manager portal exports as the manager they are", async () => {
    const user = await roleSent("");
    expect(user.role).toBe("manager");
    expect(user.roles).not.toContain("admin");
  });

  it("an admin page that asks for oversight exports every owner's tours", async () => {
    expect((await roleSent("?oversight=admin")).role).toBe("admin");
  });

  it("a non-admin sending the oversight parameter is still a manager", async () => {
    hoisted.admin = false;
    expect((await roleSent("?oversight=admin")).role).toBe("manager");
  });
});

describe("admin writes from the manager portal cannot touch another owner's rows", () => {
  const post = (path: string, query: string, body: unknown) =>
    new Request(`https://example.test${path}${query}`, { method: "POST", body: JSON.stringify(body) });
  const wrote = (table: string, id: string) =>
    hoisted.writes.filter((w) => w.table === table && (w.record as Row | null)?.id === id);

  it("promotions: a replace without oversight skips another owner's promotion (no re-own)", async () => {
    const { POST } = await import("@/app/api/portal-promotions/route");
    const res = await POST(post("/api/portal-promotions", "", { action: "replace", rows: [{ id: "pr-other" }, { id: "pr-new" }] }));
    expect(res.status).toBe(200);
    expect(wrote("manager_promotion_records", "pr-other")).toHaveLength(0);
    expect(wrote("manager_promotion_records", "pr-new")).toHaveLength(1);
  });

  it("promotions: with oversight an admin may still write any owner's promotion", async () => {
    const { POST } = await import("@/app/api/portal-promotions/route");
    await POST(post("/api/portal-promotions", "?oversight=admin", { action: "replace", rows: [{ id: "pr-other" }] }));
    expect(wrote("manager_promotion_records", "pr-other")).toHaveLength(1);
  });

  it("promotions: a delete without oversight cannot remove another owner's promotion", async () => {
    const { POST } = await import("@/app/api/portal-promotions/route");
    await POST(post("/api/portal-promotions", "", { action: "delete", id: "pr-other" }));
    expect(hoisted.writes.filter((w) => w.op === "delete" && w.table === "manager_promotion_records")).toHaveLength(0);
  });

  it("vendors: an edit of another owner's vendor without oversight is refused", async () => {
    const { POST } = await import("@/app/api/portal-vendors/route");
    const res = await POST(post("/api/portal-vendors", "", { action: "upsert", row: { id: "v-other", name: "Taken" } }));
    expect(res.status).toBe(403);
    expect(hoisted.writes).toEqual([]);
  });

  it("vendors: a delete without oversight is pinned to the caller's own rows", async () => {
    const { POST } = await import("@/app/api/portal-vendors/route");
    await POST(post("/api/portal-vendors", "", { action: "delete", id: "v-other" }));
    expect(hoisted.writes.filter((w) => w.op === "delete")).toHaveLength(0);
  });

  it("work orders: an edit of another owner's work order without oversight is refused", async () => {
    const { POST } = await import("@/app/api/portal-work-orders/route");
    const res = await POST(post("/api/portal-work-orders", "", { action: "upsert", row: { id: "wo-other", title: "Taken" } }));
    expect(res.status).toBe(403);
    expect(hoisted.writes).toEqual([]);
  });

  it("work orders: a delete without oversight cannot remove another owner's row", async () => {
    const { POST } = await import("@/app/api/portal-work-orders/route");
    const res = await POST(post("/api/portal-work-orders", "", { action: "delete", id: "wo-other" }));
    expect(res.status).toBe(403);
    expect(hoisted.writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  it("service requests: an edit of another owner's request without oversight is refused", async () => {
    const { POST } = await import("@/app/api/portal-service-requests/route");
    const res = await POST(post("/api/portal-service-requests", "", { action: "upsert", row: { id: "sr-other", offerName: "Taken" } }));
    expect(res.status).toBe(403);
    expect(hoisted.writes).toEqual([]);
  });

  it("service requests: a delete without oversight cannot remove another owner's row", async () => {
    const { POST } = await import("@/app/api/portal-service-requests/route");
    const res = await POST(post("/api/portal-service-requests", "", { action: "delete", id: "sr-other" }));
    expect(res.status).toBe(403);
    expect(hoisted.writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  it("vendors: a non-admin sending the oversight parameter is still refused", async () => {
    hoisted.admin = false;
    const { POST } = await import("@/app/api/portal-vendors/route");
    const res = await POST(post("/api/portal-vendors", "?oversight=admin", { action: "upsert", row: { id: "v-other", name: "Taken" } }));
    expect(res.status).toBe(403);
  });
});

describe("adminOversightUrl — only admin pages ask for oversight", () => {
  const withPath = async (pathname: string | null, url: string) => {
    vi.stubGlobal("window", pathname === null ? undefined : { location: { pathname } });
    const { adminOversightUrl } = await import("@/lib/auth/admin-oversight.client");
    return adminOversightUrl(url);
  };

  it("adds the parameter under /admin", async () => {
    expect(await withPath("/admin/properties", "/api/property-records")).toBe("/api/property-records?oversight=admin");
    expect(await withPath("/admin", "/api/portal-household-charges?updatedSince=x")).toBe(
      "/api/portal-household-charges?updatedSince=x&oversight=admin",
    );
  });

  it("never adds it in the manager portal, a lookalike path, or on the server", async () => {
    expect(await withPath("/portal/properties", "/api/property-records")).toBe("/api/property-records");
    expect(await withPath("/administrator", "/api/property-records")).toBe("/api/property-records");
    expect(await withPath(null, "/api/property-records")).toBe("/api/property-records");
    vi.unstubAllGlobals();
  });
});
