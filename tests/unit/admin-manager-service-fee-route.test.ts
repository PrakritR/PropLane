/**
 * The staff control over who pays a manager's processing fees.
 *
 * This route is the authorization boundary for the one setting that can move a cost onto
 * PropLane itself. `saveAdminServiceFeeOverride` does no authorization of its own — matching every
 * other service-role writer in this codebase — so if this route lets a non-admin through, nothing
 * downstream catches it.
 *
 * The other thing worth pinning is that `null` is a real value here. Clearing the override returns
 * a manager to the plan-and-choice rule; pinning "resident" fixes the answer whatever they later
 * choose. A route that collapsed the two would quietly freeze every manager staff had touched.
 *
 * Since PRP-277 every successful change also leaves one `audit_log` row and the read returns the
 * last ten, so the second half of this file drives a small in-memory stand-in for that table and
 * checks what actually lands in it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const saveAdminServiceFeeOverride = vi.fn();
const loadManagerManualPaymentSettings = vi.fn();
const getManagerPurchaseSku = vi.fn();

type AuditRow = Record<string, unknown> & { id: string; created_at: string };
const auditRows: AuditRow[] = [];
let auditInsertError: { message: string } | null = null;
const profileRows: Array<{ id: string; email: string | null }> = [];

/** Just enough of the query builder for the audit module's insert / select / in calls. */
function auditTable() {
  const filters: Array<[string, unknown]> = [];
  let limitN = Number.POSITIVE_INFINITY;
  const q = {
    insert: async (row: Record<string, unknown>) => {
      if (auditInsertError) return { error: auditInsertError };
      auditRows.push({ ...row, id: `audit-${auditRows.length + 1}`, created_at: String(row.created_at) });
      return { error: null };
    },
    select: () => q,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return q;
    },
    order: () => q,
    limit: (n: number) => {
      limitN = n;
      return q;
    },
    then: (resolve: (value: { data: AuditRow[]; error: null }) => void) => {
      const matching = auditRows.filter((row) => filters.every(([column, value]) => row[column] === value));
      resolve({ data: matching.slice().reverse().slice(0, limitN), error: null });
    },
  };
  return q;
}

function profilesTable() {
  const q = {
    select: () => q,
    in: (_column: string, ids: string[]) =>
      Promise.resolve({ data: profileRows.filter((row) => ids.includes(row.id)), error: null }),
  };
  return q;
}

const fakeDb = {
  from(table: string) {
    if (table === "audit_log") return auditTable();
    if (table === "profiles") return profilesTable();
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fakeDb }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({
  saveAdminServiceFeeOverride: (...a: unknown[]) => saveAdminServiceFeeOverride(...a),
  loadManagerManualPaymentSettings: (...a: unknown[]) => loadManagerManualPaymentSettings(...a),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: (...a: unknown[]) => getManagerPurchaseSku(...a),
}));

const { GET, POST, PATCH } = await import("@/app/api/admin/manager-service-fee/route");

const send = (method: "POST" | "PATCH", body: unknown) =>
  (method === "PATCH" ? PATCH : POST)(
    new Request("https://prop-lane.space/api/admin/manager-service-fee", {
      method,
      body: JSON.stringify(body),
    }),
  );
const post = (body: unknown) => send("POST", body);
const read = () => GET(new Request("https://x/api/admin/manager-service-fee?managerUserId=mgr-1"));

beforeEach(() => {
  vi.clearAllMocks();
  auditRows.length = 0;
  auditInsertError = null;
  profileRows.length = 0;
  profileRows.push({ id: "admin-1", email: "staff@prop-lane.space" });
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
  getManagerPurchaseSku.mockResolvedValue({ tier: "pro" });
  // A tiny stand-in for the stored settings so "before" and "after" differ the way they would
  // against the real table: the save mutates what the next load returns.
  const stored: { serviceFeePayer: string; adminServiceFeeOverride: string | null } = {
    serviceFeePayer: "resident",
    adminServiceFeeOverride: null,
  };
  loadManagerManualPaymentSettings.mockImplementation(async () => ({ ...stored }));
  saveAdminServiceFeeOverride.mockImplementation(async (_db, _id, override) => {
    stored.adminServiceFeeOverride = override;
    return { ...stored };
  });
});

describe("who may call it", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ managerUserId: "mgr-1", adminOverride: "proplane" })).status).toBe(401);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("refuses a signed-in NON-admin", async () => {
    // The manager whose fees these are must not be able to call it either.
    isAdminUser.mockResolvedValue(false);
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
    expect((await post({ managerUserId: "mgr-1", adminOverride: "proplane" })).status).toBe(401);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("refuses a read to a non-admin too", async () => {
    isAdminUser.mockResolvedValue(false);
    expect((await read()).status).toBe(401);
  });
});

describe("what it accepts", () => {
  it("sets an override", async () => {
    const res = await post({ managerUserId: "mgr-1", adminOverride: "proplane" });
    expect(res.status).toBe(200);
    expect(saveAdminServiceFeeOverride).toHaveBeenCalledWith(expect.anything(), "mgr-1", "proplane");
    expect((await res.json()).effectivePayer).toBe("proplane");
  });

  it("answers PATCH with the same handler as POST", async () => {
    const res = await send("PATCH", { managerUserId: "mgr-1", adminOverride: "manager" });
    expect(res.status).toBe(200);
    expect(saveAdminServiceFeeOverride).toHaveBeenCalledWith(expect.anything(), "mgr-1", "manager");
  });

  it("clears an override with an explicit null", async () => {
    // Distinct from pinning "resident" — this hands the manager back to the plan rule.
    const res = await post({ managerUserId: "mgr-1", adminOverride: null });
    expect(res.status).toBe(200);
    expect(saveAdminServiceFeeOverride).toHaveBeenCalledWith(expect.anything(), "mgr-1", null);
  });

  it("rejects an unrecognised value instead of coercing it", async () => {
    // Reading it as "resident" would report success while doing something else.
    const res = await post({ managerUserId: "mgr-1", adminOverride: "free" });
    expect(res.status).toBe(400);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("requires a manager id", async () => {
    expect((await post({ adminOverride: "manager" })).status).toBe(400);
    expect((await post({ managerUserId: "   ", adminOverride: "manager" })).status).toBe(400);
  });
});

describe("what it reports back", () => {
  it("reports the NET payer, not just what was stored", async () => {
    // A free-tier manager who chose to absorb fees still cannot, so the screen must show
    // "resident" rather than echoing the stored choice and disagreeing with the actual charge.
    getManagerPurchaseSku.mockResolvedValue({ tier: "free" });
    loadManagerManualPaymentSettings.mockResolvedValue({
      serviceFeePayer: "manager",
      adminServiceFeeOverride: null,
    });
    const body = await (await read()).json();
    expect(body.managerChoice).toBe("manager");
    expect(body.effectivePayer).toBe("resident");
  });

  it("shows staff overriding the plan floor", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "free" });
    loadManagerManualPaymentSettings.mockResolvedValue({
      serviceFeePayer: "resident",
      adminServiceFeeOverride: "proplane",
    });
    expect((await (await read()).json()).effectivePayer).toBe("proplane");
  });

  it("does not leak an internal error message", async () => {
    saveAdminServiceFeeOverride.mockRejectedValue(new Error("supabase: service role key revoked"));
    const res = await post({ managerUserId: "mgr-1", adminOverride: "manager" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("service role");
  });
});

describe("the audit trail (PRP-277)", () => {
  it("writes one audit_log row per successful change, with before and after", async () => {
    const res = await post({ managerUserId: "mgr-1", adminOverride: "proplane", reason: "  Agreed at launch  " });
    expect(res.status).toBe(200);

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.actor_user_id).toBe("admin-1");
    expect(row.landlord_id).toBe("mgr-1");
    expect(row.action).toBe("admin_service_fee_override");
    expect(row.input_summary).toEqual({ previousOverride: null, newOverride: "proplane", reason: "Agreed at launch" });
    expect(row.result_summary).toEqual({ effectiveBefore: "resident", effectiveAfter: "proplane" });
    expect(typeof row.created_at).toBe("string");
  });

  it("records a CLEAR as null → null-override, not as 'resident'", async () => {
    await post({ managerUserId: "mgr-1", adminOverride: "manager" });
    await post({ managerUserId: "mgr-1", adminOverride: null });
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1].input_summary).toMatchObject({ previousOverride: "manager", newOverride: null });
    expect(auditRows[1].result_summary).toEqual({ effectiveBefore: "manager", effectiveAfter: "resident" });
  });

  it("stores no reason when none was given, and caps a long one", async () => {
    await post({ managerUserId: "mgr-1", adminOverride: "manager" });
    expect((auditRows[0].input_summary as { reason: unknown }).reason).toBeNull();

    await post({ managerUserId: "mgr-1", adminOverride: "resident", reason: "x".repeat(1000) });
    expect((auditRows[1].input_summary as { reason: string }).reason).toHaveLength(240);

    // A non-string reason is ignored rather than stringified into the trail.
    await post({ managerUserId: "mgr-1", adminOverride: "manager", reason: { nested: true } });
    expect((auditRows[2].input_summary as { reason: unknown }).reason).toBeNull();
  });

  it("returns the changes on the write and on the read, newest first, with who made them", async () => {
    await post({ managerUserId: "mgr-1", adminOverride: "manager", reason: "first" });
    const second = await (await post({ managerUserId: "mgr-1", adminOverride: "proplane", reason: "second" })).json();

    expect(second.changes).toHaveLength(2);
    expect(second.changes[0]).toMatchObject({
      actorUserId: "admin-1",
      actorEmail: "staff@prop-lane.space",
      managerUserId: "mgr-1",
      previousOverride: "manager",
      newOverride: "proplane",
      effectiveBefore: "manager",
      effectiveAfter: "proplane",
      reason: "second",
    });
    expect(second.changes[1]).toMatchObject({ previousOverride: null, newOverride: "manager", reason: "first" });

    const body = await (await read()).json();
    expect(body.changes.map((c: { reason: string }) => c.reason)).toEqual(["second", "first"]);
    expect(body.changes[0].at).toBe(auditRows[1].created_at);
  });

  it("labels a change by a deleted staff member without their email", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "admin-gone" } } });
    await post({ managerUserId: "mgr-1", adminOverride: "manager" });
    const body = await (await read()).json();
    expect(body.changes[0]).toMatchObject({ actorUserId: "admin-gone", actorEmail: null });
  });

  it("returns at most the last ten", async () => {
    for (let i = 0; i < 12; i += 1) {
      await post({ managerUserId: "mgr-1", adminOverride: i % 2 ? "manager" : "resident", reason: `r${i}` });
    }
    const body = await (await read()).json();
    expect(body.changes).toHaveLength(10);
    expect(body.changes[0].reason).toBe("r11");
  });

  it("does not list another manager's changes", async () => {
    await post({ managerUserId: "mgr-2", adminOverride: "proplane" });
    const body = await (await read()).json();
    expect(body.changes).toEqual([]);
  });

  it("answers 500 when the change cannot be recorded", async () => {
    // The override write itself succeeds here, which is exactly why the client re-reads on an
    // error instead of restoring its previous selection.
    auditInsertError = { message: "audit_log unavailable" };
    const res = await post({ managerUserId: "mgr-1", adminOverride: "proplane" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("audit_log");
  });
});
