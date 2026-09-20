/**
 * EVIDENCE HARNESS — the settings route's answer to a code-less "PropLane covers it".
 *
 * Drives the REAL `PATCH /api/portal/manager-manual-payment-settings` handler and
 * records the request/response transcript. A code-less `proplane` selection is
 * REFUSED with 400 — it used to be stored as a quietly downgraded `resident` and
 * answered 200, so the manager was told their fees were covered when they were
 * not. A valid promo code, or a promo grant already on the account, is what lets
 * the selection through (captain decision September 12, 2026).
 *
 * Set EVIDENCE_DIR to dump the transcript.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID } from "@/lib/payment-policy";

const OUT = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
afterAll(() => {
  if (!OUT || transcript.length === 0) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/manual-payment-settings-route.transcript.txt`, transcript.join("\n"), "utf8");
});

const MANAGER_ID = "mgr-evidence-1";

/** The one stored settings row, as `manual_payments` JSON on the manager's record. */
let stored: Record<string, unknown> | null = null;
/** The account's `manager_purchases.promo_code`, the other promo source. */
let accountPromoCode: string | null = null;

const db = {
  from(table: string) {
    if (table === "profiles") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "manager" }, error: null }) }) }),
      };
    }
    if (table === "profile_roles") {
      return { select: () => ({ eq: async () => ({ data: [{ role: "manager" }], error: null }) }) };
    }
    // `assertSettingsScopeOwned` (PLAN-0920-0845) reads the workspace's owner
    // before the route's own `saveWorkspacePaymentSettings` runs — every
    // workspace id this test uses belongs to MANAGER_ID.
    if (table === "portal_workspaces") {
      let workspaceId: string | undefined;
      return {
        select: () => ({
          eq: (col: string, val: unknown) => {
            if (col === "id") workspaceId = String(val);
            return { maybeSingle: async () => ({ data: { id: workspaceId, owner_user_id: MANAGER_ID }, error: null }) };
          },
        }),
      };
    }
    return {
      select: () => ({
        limit: async () => ({ data: [], error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: stored ? { manual_payments: stored } : null, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        stored = row.manual_payments as Record<string, unknown>;
        return { error: null };
      },
    };
  },
  /** What `save_manager_payment_preferences` does with the server's grant answer. */
  rpc: async (fn: string, args: { p_settings: Record<string, unknown>; p_coverage_granted?: boolean }) => {
    if (fn !== "save_manager_payment_preferences") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    const next: Record<string, unknown> = { ...args.p_settings };
    delete next.adminServiceFeeOverride;
    if (stored?.adminServiceFeeOverride) next.adminServiceFeeOverride = stored.adminServiceFeeOverride;
    if (next.serviceFeePayer === "proplane" && args.p_coverage_granted !== true && stored?.adminServiceFeeOverride !== "proplane") {
      next.serviceFeePayer = "resident";
      delete next.serviceFeeWaiverCode;
    }
    stored = next;
    return { data: next, error: null };
  },
} as never;

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: MANAGER_ID, user_metadata: { role: "manager" } } } }) },
  }),
}));
vi.mock("@/lib/manager-manual-payment-settings.server", () => ({
  applyManagerManualPaymentsToListings: async () => ({ listingsUpdated: 0, chargesUpdated: 0 }),
}));
/** The one workspace's `portal_workspaces.payment_settings`, keyed by workspace id. */
let workspaceStored: Record<string, Record<string, unknown> | null> = {};
vi.mock("@/lib/workspace-payment-settings.server", () => ({
  loadWorkspacePaymentSettings: async () =>
    Object.fromEntries(
      Object.entries(workspaceStored).map(([id, value]) => [
        id,
        {
          serviceFeePayer: value?.serviceFeePayer ?? null,
          ...(typeof value?.serviceFeeWaiverCode === "string" ? { serviceFeeWaiverCode: value.serviceFeeWaiverCode } : {}),
        },
      ]),
    ),
  saveWorkspacePaymentSettings: async (
    _db: unknown,
    _owner: string,
    workspaceId: string,
    next: { serviceFeePayer: string | null; serviceFeeWaiverCode?: string },
  ) => {
    workspaceStored[workspaceId] =
      next.serviceFeePayer === null
        ? null
        : { serviceFeePayer: next.serviceFeePayer, ...(next.serviceFeeWaiverCode ? { serviceFeeWaiverCode: next.serviceFeeWaiverCode } : {}) };
    return { saved: true };
  },
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: async () => ({
    tier: "free",
    billing: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeCheckoutSessionId: null,
    promoCode: accountPromoCode,
    appleOriginalTransactionId: null,
    paidAt: null,
    readFailed: false,
  }),
}));

const { PATCH } = await import("@/app/api/portal/manager-manual-payment-settings/route");

const BASE = {
  axisPaymentsEnabled: true,
};

async function patch(label: string, body: Record<string, unknown>) {
  const res = await PATCH(
    new Request("http://localhost/api/portal/manager-manual-payment-settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  transcript.push(
    `### ${label}`,
    `PATCH /api/portal/manager-manual-payment-settings`,
    `> ${JSON.stringify(body)}`,
    `< ${res.status} ${JSON.stringify(json)}`,
    `  stored serviceFeePayer = ${JSON.stringify((stored as Record<string, unknown> | null)?.serviceFeePayer ?? null)}`,
    "",
  );
  return { status: res.status, json };
}

beforeEach(() => {
  stored = null;
  accountPromoCode = null;
  workspaceStored = {};
  transcript.length = 0;
});

describe("evidence · PATCH manager-manual-payment-settings", () => {
  it("refuses a code-less PropLane selection with 400 and stores nothing", async () => {
    const refused = await patch("A new 'PropLane covers it' with NO promo code", {
      ...BASE,
      serviceFeePayer: "proplane",
    });
    expect(refused.status).toBe(400);
    // Assert the SHIPPED string, not a paraphrase of it: this asserted the word
    // "promo code" while the product had been reworded to "waiver code", so a
    // deliberate copy change read as a broken refusal.
    expect(refused.json.error).toBe(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
    // Nothing was written — not even a downgraded `resident`.
    expect(stored).toBeNull();

    const wrong = await patch("…and with a WRONG promo code", {
      ...BASE,
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "NOPE123",
    });
    expect(wrong.status).toBe(400);
    expect(stored).toBeNull();

    const ok = await patch("…and with the promo code", {
      ...BASE,
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "free100",
    });
    expect(ok.status).toBe(200);
    expect(stored).toMatchObject({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });

    // A legacy account already on `proplane` carries no code. An unrelated re-save
    // must keep it there rather than quietly moving Stripe's cost onto its residents.
    stored = { ...BASE, serviceFeePayer: "proplane" };
    const carried = await patch("A legacy 'proplane' account re-saving something else", {
      ...BASE,
      axisPaymentsEnabled: false,
      serviceFeePayer: "proplane",
    });
    expect(carried.status).toBe(200);
    expect(stored).toMatchObject({ serviceFeePayer: "proplane", axisPaymentsEnabled: false });

    // The account's own promo grant (signup FREE100) needs no typed code.
    stored = null;
    accountPromoCode = "FREE100";
    const granted = await patch("An account with a signup promo grant, no typed code", {
      ...BASE,
      serviceFeePayer: "proplane",
    });
    expect(granted.status).toBe(200);
    expect(stored).toMatchObject({ serviceFeePayer: "proplane" });
    expect(stored).not.toHaveProperty("serviceFeeWaiverCode");

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/manual-payment-settings-route.transcript.txt`, transcript.join("\n"), "utf8");
    }
  });
});

describe("evidence · PATCH manager-manual-payment-settings, workspace scope", () => {
  /*
   * PropLane pays is applied per workspace only by a code at the moment it is
   * chosen (captain, 2026-09-14). A grant already on the account used to be
   * enough to flip a workspace on with nothing asked; it no longer is. The
   * code is checked against the server-only list, kept with the workspace so
   * checkout can re-validate it, and never echoed back to the browser.
   */
  const WS = "ws-1";

  it("refuses a workspace PropLane pays without a code — even on a granted account", async () => {
    accountPromoCode = "FREE100";
    const refused = await patch("Workspace 'PropLane pays', no code, account granted", {
      ...BASE,
      workspaceId: WS,
      workspaceServiceFeePayer: "proplane",
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
    expect(workspaceStored[WS]).toBeUndefined();

    const wrong = await patch("…with a WRONG code", {
      ...BASE,
      workspaceId: WS,
      workspaceServiceFeePayer: "proplane",
      workspaceServiceFeeWaiverCode: "NOPE123",
    });
    expect(wrong.status).toBe(400);
    expect(workspaceStored[WS]).toBeUndefined();
  });

  it("applies it with the code, keeps the code with the workspace, and never echoes it", async () => {
    const ok = await patch("Workspace 'PropLane pays' with the code", {
      ...BASE,
      workspaceId: WS,
      workspaceServiceFeePayer: "proplane",
      workspaceServiceFeeWaiverCode: "free100",
    });
    expect(ok.status).toBe(200);
    expect(workspaceStored[WS]).toEqual({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" });
    const echoed = ok.json.workspacePaymentSettings as Record<string, Record<string, unknown>>;
    expect(echoed[WS]).toEqual({ serviceFeePayer: "proplane" });
    expect(JSON.stringify(ok.json)).not.toContain("FREE100");
  });

  it("switching a workspace away needs no code, and staff coverage still needs none", async () => {
    workspaceStored[WS] = { serviceFeePayer: "proplane", serviceFeeWaiverCode: "FREE100" };
    const away = await patch("Workspace back to 'Resident pays'", {
      ...BASE,
      workspaceId: WS,
      workspaceServiceFeePayer: "resident",
    });
    expect(away.status).toBe(200);
    expect(workspaceStored[WS]).toEqual({ serviceFeePayer: "resident" });

    stored = { ...BASE, serviceFeePayer: "resident", adminServiceFeeOverride: "proplane" };
    const staff = await patch("Workspace 'PropLane pays' under the staff override, no code", {
      ...BASE,
      workspaceId: WS,
      workspaceServiceFeePayer: "proplane",
    });
    expect(staff.status).toBe(200);
    expect(workspaceStored[WS]).toEqual({ serviceFeePayer: "proplane" });
  });
});
