/**
 * Who is allowed to hand PropLane the bill.
 *
 * The staff override is the only way to select `proplane` — PropLane absorbing Stripe's cost so
 * that neither the resident nor the manager is charged. It is stored alongside the manager's own
 * payment settings, which is convenient and also the danger: the manager's settings route writes
 * that same record.
 *
 * So the invariant is narrow and worth pinning: the manager's own save must never be able to set
 * or clear it. Otherwise a manager stops paying processing fees by adding one field to a request
 * body, and PropLane silently picks up the cost with nothing in any log to say why.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

// Minimal Supabase double. `select("manual_payments").limit(1)` succeeding is what puts the
// module in "column" storage mode, which is the shape production runs in.
const db = {
  from() {
    return {
      select: (cols: string) => ({
        limit: async () => ({ data: [], error: null }),
        eq: () => ({
          maybeSingle: async () => ({ data: store.get("row") ?? null, error: null }),
        }),
        cols,
      }),
      upsert: async (row: Record<string, unknown>) => {
        store.set("row", { manual_payments: row.manual_payments });
        return { error: null };
      },
    };
  },
} as never;

const { loadManagerManualPaymentSettings, saveManagerManualPaymentSettings, saveAdminServiceFeeOverride } =
  await import("@/lib/manager-manual-payment-settings");

beforeEach(() => store.clear());

describe("the manager's own save", () => {
  it("cannot grant itself the override", async () => {
    // The attack is this plain: include the field in your own settings PATCH.
    await saveManagerManualPaymentSettings(db, "mgr-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "resident",
      adminServiceFeeOverride: "proplane",
    });

    const after = await loadManagerManualPaymentSettings(db, "mgr-1");
    expect(after.adminServiceFeeOverride).toBeNull();
  });

  it("cannot clear an override staff already set", async () => {
    // The mirror of the same hole: a manager who cannot switch it ON should not be able to switch
    // it OFF either, if staff pinned them to paying.
    await saveAdminServiceFeeOverride(db, "mgr-1", "manager");
    await saveManagerManualPaymentSettings(db, "mgr-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "resident",
      adminServiceFeeOverride: null,
    });

    const after = await loadManagerManualPaymentSettings(db, "mgr-1");
    expect(after.adminServiceFeeOverride).toBe("manager");
  });

  it("still saves the manager's own settings normally", async () => {
    // The protection must not turn into "manager settings stopped saving".
    await saveManagerManualPaymentSettings(db, "mgr-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "manager",
    });
    expect((await loadManagerManualPaymentSettings(db, "mgr-1")).serviceFeePayer).toBe("manager");
  });
});

describe("the staff writer", () => {
  it("sets the override", async () => {
    await saveAdminServiceFeeOverride(db, "mgr-1", "proplane");
    expect((await loadManagerManualPaymentSettings(db, "mgr-1")).adminServiceFeeOverride).toBe("proplane");
  });

  it("clears it back to no intervention, which is not the same as pinning resident", async () => {
    // Null returns the manager to the plan-and-choice rule; "resident" pins the answer whatever
    // they later choose. Collapsing the two would quietly freeze every cleared manager.
    await saveAdminServiceFeeOverride(db, "mgr-1", "proplane");
    await saveAdminServiceFeeOverride(db, "mgr-1", null);
    expect((await loadManagerManualPaymentSettings(db, "mgr-1")).adminServiceFeeOverride).toBeNull();
  });

  it("leaves the manager's own choice untouched", async () => {
    await saveManagerManualPaymentSettings(db, "mgr-1", {
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "manager",
    });
    await saveAdminServiceFeeOverride(db, "mgr-1", "proplane");
    const after = await loadManagerManualPaymentSettings(db, "mgr-1");
    expect(after.serviceFeePayer).toBe("manager");
    expect(after.adminServiceFeeOverride).toBe("proplane");
  });
});
