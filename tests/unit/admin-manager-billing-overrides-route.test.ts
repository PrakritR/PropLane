/**
 * The staff-only route for one account's billing exceptions: property cap, trial end, comp status.
 *
 * Three things are worth pinning here, in order of what they cost when wrong:
 *
 * 1. **Authorization is HERE.** `saveManagerBillingOverrides` does none of its own — matching every
 *    other service-role writer in this codebase — so a non-admin let past this route is caught by
 *    nothing downstream. A manager who could set their own property cap would have no cap.
 * 2. **A refused value is refused, never coerced.** "3.5" silently becoming 3, or "abc" becoming 0,
 *    reports success while doing something other than what was asked — and this number decides
 *    whether a paying manager can publish a listing.
 * 3. **Every accepted change leaves an audit row.** The settings blob already records the value;
 *    what it cannot record is who granted the exception and why. A field that did not actually move
 *    writes nothing, so the trail is a list of decisions rather than a list of saves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const isAdminUser = vi.fn();
const getUser = vi.fn();

/** In-memory Supabase double: settings row + audit_log, using the real read/write helpers. */
let tables: Record<string, Record<string, unknown>[]> = {};
let settingsReadError: { message: string } | null = null;
let auditInsertError: { code?: string; message: string } | null = null;

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select() {
          return q;
        },
        eq(col: string, value: unknown) {
          filters[col] = value;
          return q;
        },
        in() {
          return q;
        },
        async maybeSingle() {
          if (settingsReadError && table === "manager_automation_settings") {
            return { data: null, error: settingsReadError };
          }
          const row = (tables[table] ?? []).find((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v),
          );
          return { data: row ?? null, error: null };
        },
        async upsert(values: Record<string, unknown>) {
          const list = (tables[table] ??= []);
          const idx = list.findIndex((r) => r.manager_user_id === values.manager_user_id);
          if (idx >= 0) list[idx] = { ...list[idx], ...values };
          else list.push({ ...values });
          return { error: null };
        },
        async insert(values: Record<string, unknown>) {
          if (auditInsertError && table === "audit_log") return { error: auditInsertError };
          (tables[table] ??= []).push({ ...values });
          return { error: null };
        },
      };
      return q;
    },
  };
}

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

const { GET, PATCH } = await import("@/app/api/admin/manager-billing-overrides/route");

const MANAGER = "mgr-1";

const patch = (body: unknown) =>
  PATCH(
    new Request("https://prop-lane.space/api/admin/manager-billing-overrides", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  );

const get = (id = MANAGER) =>
  GET(new Request(`https://prop-lane.space/api/admin/manager-billing-overrides?managerUserId=${id}`));

function storedOverrides(): Record<string, unknown> | undefined {
  const row = (tables.manager_automation_settings ?? []).find((r) => r.manager_user_id === MANAGER);
  return (row?.row_data as Record<string, unknown> | undefined)?.billingOverrides as
    | Record<string, unknown>
    | undefined;
}

function auditRows(): Record<string, unknown>[] {
  return tables.audit_log ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  tables = {};
  settingsReadError = null;
  auditInsertError = null;
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
});

describe("who may call it", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await patch({ managerUserId: MANAGER, propertyCap: 9 })).status).toBe(401);
    expect(storedOverrides()).toBeUndefined();
  });

  it("refuses a signed-in NON-admin — including the manager whose cap it is", async () => {
    isAdminUser.mockResolvedValue(false);
    getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
    expect((await patch({ managerUserId: MANAGER, propertyCap: 9 })).status).toBe(401);
    expect(storedOverrides()).toBeUndefined();
  });

  it("refuses a read to a non-admin too", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await get()).status).toBe(401);
  });
});

describe("what it accepts", () => {
  it("requires a manager", async () => {
    expect((await patch({ propertyCap: 3 })).status).toBe(400);
    expect((await GET(new Request("https://x/api/admin/manager-billing-overrides"))).status).toBe(400);
  });

  it("requires at least one field to change", async () => {
    const res = await patch({ managerUserId: MANAGER });
    expect(res.status).toBe(400);
  });

  it.each([
    ["a fraction", 3.5],
    ["text", "abc"],
    ["a negative cap", -1],
    ["an absurd cap", 5000],
  ])("refuses %s rather than coercing it", async (_label, propertyCap) => {
    const res = await patch({ managerUserId: MANAGER, propertyCap });
    expect(res.status).toBe(400);
    expect(storedOverrides()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a trial end that is not a calendar date", async () => {
    expect((await patch({ managerUserId: MANAGER, trialEndsAt: "next tuesday" })).status).toBe(400);
    // 2026-02-31 exists on no calendar; accepting it would silently store 2026-03-03.
    expect((await patch({ managerUserId: MANAGER, trialEndsAt: "2026-02-31" })).status).toBe(400);
  });

  it("refuses a non-boolean comp flag", async () => {
    expect((await patch({ managerUserId: MANAGER, complimentary: "yes" })).status).toBe(400);
  });
});

describe("what it stores", () => {
  it("sets a cap and reads it back", async () => {
    const res = await patch({ managerUserId: MANAGER, propertyCap: 7, reason: "Pilot customer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, overrides: { propertyCap: 7 } });
    expect(storedOverrides()).toMatchObject({ propertyCap: 7 });

    const read = await get();
    expect(await read.json()).toMatchObject({ overrides: { propertyCap: 7 } });
  });

  it("accepts 0 as a real cap, not as 'clear it'", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 0 });
    expect(storedOverrides()).toMatchObject({ propertyCap: 0 });
  });

  it("clears with null, returning the account to its plan cap", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 7 });
    await patch({ managerUserId: MANAGER, propertyCap: null });
    // With nothing pinned the key is removed entirely, so an untouched account's settings look
    // exactly as they did before this feature existed.
    expect(storedOverrides()).toBeUndefined();
  });

  it("moves ONLY the fields the body names", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 4, trialEndsAt: "2026-12-01", complimentary: true });
    await patch({ managerUserId: MANAGER, complimentary: false });
    expect(storedOverrides()).toMatchObject({
      propertyCap: 4,
      trialEndsAt: "2026-12-01",
      complimentary: false,
    });
  });

  it("preserves the sibling settings sharing that row", async () => {
    tables.manager_automation_settings = [
      { manager_user_id: MANAGER, row_data: { tourSettings: { leadTimeHours: 12 } } },
    ];
    await patch({ managerUserId: MANAGER, propertyCap: 3 });
    const row = tables.manager_automation_settings.find((r) => r.manager_user_id === MANAGER)!;
    expect(row.row_data).toMatchObject({ tourSettings: { leadTimeHours: 12 }, billingOverrides: { propertyCap: 3 } });
  });

  it("refuses to write on top of a state it could not read", async () => {
    // The before-value is what makes the audit row worth having, and a blind write could clear a
    // cap staff had already set.
    settingsReadError = { message: "boom" };
    const res = await patch({ managerUserId: MANAGER, propertyCap: 3 });
    expect(res.status).toBe(500);
    expect(auditRows()).toHaveLength(0);
  });

  it("does not report an unreadable override as 'nothing is set'", async () => {
    settingsReadError = { message: "boom" };
    expect((await get()).status).toBe(500);
  });
});

describe("the audit trail", () => {
  it("records actor, manager, field, before → after and the reason", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 7, reason: "  Pilot   customer  " });
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actor_user_id: "admin-1",
      landlord_id: MANAGER,
      action: "admin_billing_override",
      input_summary: {
        field: "propertyCap",
        before: null,
        after: 7,
        managerUserId: MANAGER,
        reason: "Pilot customer",
      },
    });
  });

  it("writes one row per field that actually moved", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 7, trialEndsAt: "2026-12-01", complimentary: true });
    expect(auditRows().map((r) => (r.input_summary as { field: string }).field).sort()).toEqual([
      "complimentary",
      "propertyCap",
      "trialEndsAt",
    ]);
  });

  it("writes nothing when a save changes nothing", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 7 });
    tables.audit_log = [];
    await patch({ managerUserId: MANAGER, propertyCap: 7 });
    expect(auditRows()).toHaveLength(0);
  });

  it("carries the before value across a clear", async () => {
    await patch({ managerUserId: MANAGER, propertyCap: 7 });
    tables.audit_log = [];
    await patch({ managerUserId: MANAGER, propertyCap: null });
    expect(auditRows()[0]).toMatchObject({ input_summary: { field: "propertyCap", before: 7, after: null } });
  });

  it("reports a failed audit insert instead of claiming the change was recorded", async () => {
    auditInsertError = { message: "audit down" };
    const res = await patch({ managerUserId: MANAGER, propertyCap: 7 });
    // The write itself already landed — losing the whole response over the trail would be worse
    // than a gap in it — but the caller is told so it can say so.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditRecorded: false });
    expect(storedOverrides()).toMatchObject({ propertyCap: 7 });
  });
});
