/**
 * PATCH /api/admin/residents and /api/admin/vendors: Disable / Enable.
 *
 * One popup collects the staff member's reason for every account kind, so every one of the three
 * routes must require it and leave an audit row - a reason the route discarded would be worse than
 * never asking for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const isAdminUser = vi.fn();
const getUser = vi.fn();

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Row | null = null;
      const run = () => {
        const rows = (tables[table] ??= []);
        const matching = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (patch) {
          for (const r of matching) Object.assign(r, patch);
          return { data: null, error: null };
        }
        return { data: matching, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, value: unknown) => ((filters[col] = value), q),
        update: (values: Row) => ((patch = values), q),
        insert: async (values: Row) => {
          (tables[table] ??= []).push({ ...values });
          return { error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  };
}

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/auth/admin-role", () => ({ userHoldsAdminRole: async () => true }));
vi.mock("@/lib/auth/delete-portal-account", () => ({
  deleteAdminPortalAccount: async () => ({ ok: true }),
  deleteVendorAccount: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

const residents = await import("@/app/api/admin/residents/route");
const vendors = await import("@/app/api/admin/vendors/route");

const ID = "22222222-2222-4222-8222-222222222222";
const audit = () => tables.audit_log ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  tables = { profiles: [{ id: ID, application_approved: true }] };
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
});

const cases: Array<{ kind: "resident" | "vendor"; patch: (body: unknown) => Promise<Response> }> = [
  {
    kind: "resident",
    patch: (body) =>
      residents.PATCH(
        new Request("https://prop-lane.space/api/admin/residents", { method: "PATCH", body: JSON.stringify(body) }),
      ),
  },
  {
    kind: "vendor",
    patch: (body) =>
      vendors.PATCH(
        new Request("https://prop-lane.space/api/admin/vendors", { method: "PATCH", body: JSON.stringify(body) }),
      ),
  },
];

describe.each(cases)("$kind disable / enable", ({ kind, patch }) => {

  it.each([undefined, "", "   "])("refuses reason %j and changes nothing", async (reason) => {
    const res = await patch({ id: ID, active: false, reason });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "A reason is required." });
    expect(tables.profiles![0]!.application_approved).toBe(true);
    expect(audit()).toHaveLength(0);
  });

  it("disables with a reason and audits actor, before -> after and reason", async () => {
    const res = await patch({ id: ID, active: false, reason: "  Fraud   review " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditRecorded: true });
    expect(tables.profiles![0]!.application_approved).toBe(false);
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({
      actor_user_id: "admin-1",
      landlord_id: ID,
      action: "admin_account_active",
      input_summary: { field: "active", before: true, after: false, accountKind: kind, accountUserId: ID, reason: "Fraud review" },
    });
  });

  it("refuses a missing or non-boolean active", async () => {
    expect((await patch({ id: ID, reason: "x" })).status).toBe(400);
    expect((await patch({ id: ID, active: "false", reason: "x" })).status).toBe(400);
    expect((await patch({ active: false, reason: "x" })).status).toBe(400);
    expect(audit()).toHaveLength(0);
  });

  it("is staff-only", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await patch({ id: ID, active: false, reason: "x" })).status).toBe(401);
    expect(tables.profiles![0]!.application_approved).toBe(true);
  });
});
