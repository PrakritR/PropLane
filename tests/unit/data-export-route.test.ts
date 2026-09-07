/**
 * `POST /api/portal/data-export` — the manager's encrypted self-export (PRP-324).
 *
 * The session is the only identity, the password is the only key, and the reply is an
 * attachment the browser must never render. Everything below the auth gate is mocked at
 * the Supabase client so the route's own decisions — who may export, how often, what the
 * headers say — are what is under test.
 */
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptExportPayload } from "@/lib/account-export/export-crypto";
import { managerExportTables } from "@/lib/account-export/collect-manager-export.server";

const { getUser, track } = vi.hoisted(() => ({ getUser: vi.fn(), track: vi.fn() }));

type Row = Record<string, unknown>;
/** Rows the fake database holds, keyed by table. */
let store: Record<string, Row[]> = {};
let roleRows: { role: string }[] = [];
let profileRow: { role: string | null; email: string | null } | null = null;

function matches(row: Row, filters: { column: string; value: unknown; op: "eq" | "neq" }[]) {
  return filters.every(({ column, value, op }) => (op === "eq" ? row[column] === value : row[column] !== value));
}

/** The subset of PostgREST's builder the route and collector use, over the in-memory store. */
function fakeDb() {
  return {
    from(table: string) {
      const filters: { column: string; value: unknown; op: "eq" | "neq" }[] = [];
      let range: [number, number] | null = null;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value, op: "eq" });
          return builder;
        },
        neq: (column: string, value: unknown) => {
          filters.push({ column, value, op: "neq" });
          return builder;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return builder;
        },
        maybeSingle: async () => {
          if (table === "profiles") return { data: profileRow, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
          if (table === "profile_roles") return resolve({ data: roleRows, error: null });
          const rows = (store[table] ?? []).filter((row) => matches(row, filters));
          const page = range ? rows.slice(range[0], range[1] + 1) : rows;
          return resolve({ data: page, error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => fakeDb(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));

import { POST } from "@/app/api/portal/data-export/route";

const PASSWORD = "a long enough export password";

function req(body: unknown) {
  return new Request("http://localhost:3000/api/portal/data-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Distinct manager per test — the rate limiter buckets per user and persists per module. */
let seq = 0;
function signIn(overrides: { roles?: string[]; email?: string } = {}) {
  seq += 1;
  const id = `manager-${seq}`;
  const email = overrides.email ?? `manager-${seq}@example.com`;
  getUser.mockResolvedValue({ data: { user: { id, email } }, error: null });
  roleRows = (overrides.roles ?? ["manager"]).map((role) => ({ role }));
  profileRow = { role: overrides.roles?.[0] ?? "manager", email };
  return { id, email };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store = {};
  roleRows = [];
  profileRow = null;
  getUser.mockReset();
  track.mockReset();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("POST /api/portal/data-export", () => {
  it("refuses an unauthenticated call with a generic 401", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "JWT expired" } });
    const res = await POST(req({ password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized." });
    expect(track).not.toHaveBeenCalled();
  });

  it("refuses a short, missing, or non-string password before touching the database", async () => {
    signIn();
    expect((await POST(req({ password: "short" }))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ password: 42 }))).status).toBe(400);
    expect((await POST(req("{not json"))).status).toBe(400);
    expect((await POST(req({ password: "elevenchars" }))).status).toBe(400);
    expect(track).not.toHaveBeenCalled();
  });

  it("refuses an account with no manager role", async () => {
    signIn({ roles: ["resident"] });
    const res = await POST(req({ password: PASSWORD }));
    expect(res.status).toBe(403);
    expect(track).not.toHaveBeenCalled();
  });

  it("answers the manager's own rows as an encrypted attachment, PII stripped", async () => {
    const me = signIn();
    const stranger = { id: "manager-other", email: "other@example.com" };
    store = {
      manager_property_records: [
        { id: "p1", manager_user_id: me.id, row_data: { name: "12 Elm", api_key: "leak" } },
        { id: "p2", manager_user_id: stranger.id, row_data: { name: "not yours" } },
      ],
      manager_application_records: [
        {
          id: "a1",
          manager_user_id: me.id,
          resident_email: "sam@example.com",
          row_data: { application: { fullName: "Sam", ssn: "123-45-6789", dateOfBirth: "1990-01-01" } },
        },
      ],
      // Keyed by BOTH user_id and email: must come back once.
      manager_purchases: [{ id: "buy1", user_id: me.id, email: me.email, tier: "pro" }],
      // A resident's row on a table the manager only DETACHES from: never theirs to export.
      gl_journal_lines: [{ id: "g1", resident_user_id: me.id, amount_cents: 5 }],
      // The shared admin inbox is excluded by the manifest's restrict guard.
      portal_inbox_thread_records: [
        { id: "t1", owner_user_id: me.id, scope: "admin", row_data: { subject: "support" } },
        { id: "t2", owner_user_id: me.id, scope: "manager", row_data: { subject: "mine" } },
      ],
    };

    const res = await POST(req({ password: PASSWORD }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="proplane-export-\d{4}-\d{2}-\d{2}\.proplane"$/);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(() => decryptExportPayload(bytes, "definitely the wrong one")).toThrow();
    const zip = unzipSync(new Uint8Array(decryptExportPayload(bytes, PASSWORD)));

    const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
    expect(manifest.managerId).toBe(me.id);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.tableCount).toBe(managerExportTables().length);
    expect(manifest.rowCount).toBe(4);
    expect(manifest.tables.manager_property_records).toEqual({ rows: 1 });
    expect(manifest.tables.manager_purchases).toEqual({ rows: 1 });
    expect(manifest.tables.portal_inbox_thread_records).toEqual({ rows: 1 });
    expect(manifest.tables.gl_journal_lines).toBeUndefined();
    expect(zip["tables/gl_journal_lines.json"]).toBeUndefined();

    const properties = JSON.parse(strFromU8(zip["tables/manager_property_records.json"]));
    expect(properties).toEqual([{ id: "p1", manager_user_id: me.id, row_data: { name: "12 Elm" } }]);
    const applications = JSON.parse(strFromU8(zip["tables/manager_application_records.json"]));
    expect(applications[0].row_data.application).toEqual({ fullName: "Sam" });
    const threads = JSON.parse(strFromU8(zip["tables/portal_inbox_thread_records.json"]));
    expect(threads.map((row: Row) => row.id)).toEqual(["t2"]);

    const everything = Object.values(zip)
      .map((entry) => strFromU8(entry))
      .join("\n");
    expect(everything).not.toContain("123-45-6789");
    expect(everything).not.toContain("1990-01-01");
    expect(everything).not.toContain("leak");
    expect(everything).not.toContain("not yours");

    expect(track).toHaveBeenCalledWith("data_export_completed", me.id, {
      tableCount: managerExportTables().length,
      rowCount: 4,
    });
  });

  it("allows one export per manager per window", async () => {
    signIn();
    expect((await POST(req({ password: PASSWORD }))).status).toBe(200);
    const again = await POST(req({ password: PASSWORD }));
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("600");
    expect(track).toHaveBeenCalledTimes(1);
  });
});
