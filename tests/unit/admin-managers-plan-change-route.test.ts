/**
 * PATCH /api/admin/managers: Save plan.
 *
 * A staff plan change is a commercial decision about one account, so it now REQUIRES a reason and
 * writes one audit row (actor, field, before -> after, reason). The reason is refused before any
 * write - including the `active` toggle that may ride along in the same request - and a plain
 * enable/disable still needs none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
const isAdminUser = vi.fn();
const getUser = vi.fn();
const setManagerPurchaseTier = vi.fn();

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
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/manager-access-server", () => ({
  setManagerPurchaseTier: (...a: unknown[]) => setManagerPurchaseTier(...a),
}));

const { PATCH } = await import("@/app/api/admin/managers/route");

const MGR = "11111111-1111-4111-8111-111111111111";
const patch = (body: unknown) =>
  PATCH(new Request("https://prop-lane.space/api/admin/managers", { method: "PATCH", body: JSON.stringify(body) }));
const audit = () => tables.audit_log ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  tables = {
    manager_purchases: [{ id: "p1", user_id: MGR, tier: "pro", billing: "monthly", paid_at: "2026-09-01T00:00:00.000Z" }],
    profiles: [{ id: MGR, application_approved: true }],
  };
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
  setManagerPurchaseTier.mockResolvedValue({ ok: true });
});

describe("Save plan requires a reason", () => {
  it.each([undefined, "", "   "])("refuses reason %j before any write, bundled active toggle included", async (reason) => {
    const res = await patch({ id: MGR, tier: "business", active: false, reason });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "A reason is required." });
    expect(setManagerPurchaseTier).not.toHaveBeenCalled();
    expect(tables.profiles![0]!.application_approved).toBe(true);
    expect(audit()).toHaveLength(0);
  });

  it("refuses an unknown tier before asking for anything else", async () => {
    const res = await patch({ id: MGR, tier: "platinum", reason: "x" });
    expect(res.status).toBe(400);
    expect(setManagerPurchaseTier).not.toHaveBeenCalled();
  });

  it("still lets staff enable or disable an account with no reason", async () => {
    const res = await patch({ id: MGR, active: false });
    expect(res.status).toBe(200);
    expect(tables.profiles![0]!.application_approved).toBe(false);
    expect(audit()).toHaveLength(0);
  });

  it("rejects an id that is not a UUID before touching anything", async () => {
    for (const id of ["abc", "1 or 1=1", 42, { $ne: 1 }]) {
      expect((await patch({ id, active: false })).status).toBe(400);
    }
    expect(setManagerPurchaseTier).not.toHaveBeenCalled();
  });

  it("is staff-only", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await patch({ id: MGR, tier: "business", reason: "x" })).status).toBe(401);
    expect(setManagerPurchaseTier).not.toHaveBeenCalled();
  });
});

describe("Save plan audits the change", () => {
  it("writes one row: actor, manager, field plan, before -> after, and the trimmed reason", async () => {
    const res = await patch({ id: MGR, tier: "business", reason: "  Annual   deal signed " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditRecorded: true });
    expect(setManagerPurchaseTier).toHaveBeenCalledWith(MGR, "business", { adminOverride: true });
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({
      actor_user_id: "admin-1",
      landlord_id: MGR,
      action: "admin_billing_override",
      input_summary: { field: "plan", before: "pro", after: "business", managerUserId: MGR, reason: "Annual deal signed" },
    });
  });

  it("reads the before-plan as Free for an account with no purchase", async () => {
    tables.manager_purchases = [];
    await patch({ id: MGR, tier: "pro", reason: "Comped for launch" });
    expect(audit()[0]).toMatchObject({ input_summary: { field: "plan", before: "free", after: "pro" } });
  });

  it("writes no audit row, and says so, when the plan write failed", async () => {
    setManagerPurchaseTier.mockResolvedValue({ ok: false, error: "constraint violated: secret" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await patch({ id: MGR, tier: "business", reason: "x" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(audit()).toHaveLength(0);
  });
});
