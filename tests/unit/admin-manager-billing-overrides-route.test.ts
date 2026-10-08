/**
 * The staff-only route for one account's billing exceptions: property cap, trial end, comp status,
 * promo code.
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
 * 4. **Trial end, complimentary and promo code are LIVE and need a reason.** The route validates
 *    everything and demands the reason BEFORE it applies anything (so a refused request never
 *    leaves the property cap changed), then delegates to `admin-billing-actions.server`, whose own
 *    behaviour (Stripe, resolver date, audit row) is pinned in `admin-billing-actions.test.ts`.
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

const extendAccountTrial = vi.fn();
const setAccountComplimentary = vi.fn();
const applyAccountPromoCode = vi.fn();
vi.mock("@/lib/admin/admin-billing-actions.server", () => ({
  extendAccountTrial: (...a: unknown[]) => extendAccountTrial(...a),
  setAccountComplimentary: (...a: unknown[]) => setAccountComplimentary(...a),
  applyAccountPromoCode: (...a: unknown[]) => applyAccountPromoCode(...a),
}));

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
  extendAccountTrial.mockResolvedValue({ ok: true, auditRecorded: true, trialEndsAt: "2026-12-01", via: "stripe" });
  setAccountComplimentary.mockResolvedValue({ ok: true, auditRecorded: true, complimentary: true, changed: true });
  applyAccountPromoCode.mockResolvedValue({ ok: true, auditRecorded: true, promoCode: "FREEFIRST" });
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
    tables.manager_automation_settings = [
      {
        manager_user_id: MANAGER,
        row_data: { billingOverrides: { propertyCap: 4, trialEndsAt: "2026-12-01", complimentary: true } },
      },
    ];
    await patch({ managerUserId: MANAGER, propertyCap: 9 });
    expect(storedOverrides()).toMatchObject({ propertyCap: 9, trialEndsAt: "2026-12-01", complimentary: true });
    expect(extendAccountTrial).not.toHaveBeenCalled();
    expect(setAccountComplimentary).not.toHaveBeenCalled();
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

  it("writes the cap's row itself and leaves the live actions to write their own", async () => {
    const res = await patch({
      managerUserId: MANAGER,
      propertyCap: 7,
      trialEndsAt: "2026-12-01",
      complimentary: true,
      promoCode: "FREEFIRST",
      reason: "Pilot customer",
    });
    expect(res.status).toBe(200);
    expect(auditRows().map((r) => (r.input_summary as { field: string }).field)).toEqual(["propertyCap"]);
    const expected = { db: expect.anything(), actorUserId: "admin-1", managerUserId: MANAGER, reason: "Pilot customer" };
    expect(extendAccountTrial).toHaveBeenCalledWith(expect.objectContaining(expected), "2026-12-01");
    expect(setAccountComplimentary).toHaveBeenCalledWith(expect.objectContaining(expected), true);
    expect(applyAccountPromoCode).toHaveBeenCalledWith(expect.objectContaining(expected), "FREEFIRST");
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

describe("the live actions: trial end, complimentary, promo code", () => {
  it.each([
    ["trialEndsAt", { trialEndsAt: "2026-12-01" }],
    ["complimentary", { complimentary: true }],
    ["promoCode", { promoCode: "FREEFIRST" }],
  ])("%s without a reason is refused before ANYTHING is applied", async (_field, change) => {
    const res = await patch({ managerUserId: MANAGER, propertyCap: 7, ...change });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "A reason is required." });
    // The cap in the same request must not have been written ahead of the refusal.
    expect(storedOverrides()).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
    expect(extendAccountTrial).not.toHaveBeenCalled();
    expect(setAccountComplimentary).not.toHaveBeenCalled();
    expect(applyAccountPromoCode).not.toHaveBeenCalled();
  });

  it("a reason of only spaces counts as none", async () => {
    expect((await patch({ managerUserId: MANAGER, complimentary: true, reason: "   " })).status).toBe(400);
    expect(setAccountComplimentary).not.toHaveBeenCalled();
  });

  it("refuses a trial end of null - clearing a recorded date no longer exists", async () => {
    const res = await patch({ managerUserId: MANAGER, trialEndsAt: null, reason: "x" });
    expect(res.status).toBe(400);
    expect(extendAccountTrial).not.toHaveBeenCalled();
  });

  it("passes an action's refusal through with its own status and message", async () => {
    applyAccountPromoCode.mockResolvedValue({ ok: false, status: 404, error: "No active promotion code named NOPE." });
    const res = await patch({ managerUserId: MANAGER, promoCode: "NOPE", reason: "Sales call" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "No active promotion code named NOPE." });
  });

  it("reports a missing audit row from an action as auditRecorded: false", async () => {
    setAccountComplimentary.mockResolvedValue({ ok: true, auditRecorded: false, complimentary: true, changed: true });
    const res = await patch({ managerUserId: MANAGER, complimentary: true, reason: "Sales call" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditRecorded: false });
  });

  it("never lets a non-admin reach them", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await patch({ managerUserId: MANAGER, complimentary: true, reason: "x" })).status).toBe(401);
    expect(setAccountComplimentary).not.toHaveBeenCalled();
  });
});
