/**
 * The service owner's work number is entitled regardless of plan - and nobody else's is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MANAGER = "44444444-4444-4444-8444-444444444444";

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: async () => ({ readFailed: false, tier: "free", billing: null, paidAt: null, stripeSubscriptionId: null }),
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "free" }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));

const ent = await import("@/lib/sms/manager-sms-entitlement.server");

let db: ServiceFakeDb;
beforeEach(() => {
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    sms_manager_entitlements: [
      { manager_user_id: OWNER, tier: "free", source: "none", status: "active", eligible: false },
      { manager_user_id: MANAGER, tier: "free", source: "none", status: "active", eligible: false },
    ],
    portal_workspaces: [],
    account_link_invites: [],
  });
});

describe("service owner number entitlement", () => {
  it("reconcile grants the service owner an eligible entitlement on a Free plan", async () => {
    expect(await ent.reconcileManagerSmsEntitlement(db as never, OWNER)).toMatchObject({ eligible: true });
  });

  it("reconcile does not grant any other account (Free stays ineligible)", async () => {
    expect(await ent.reconcileManagerSmsEntitlement(db as never, MANAGER)).toMatchObject({ eligible: false, reason: "free" });
  });

  it("the dispatch-time stored read agrees: owner eligible, everyone else per their row", async () => {
    expect(await ent.getStoredManagerSmsEntitlement(db as never, OWNER)).toMatchObject({ eligible: true });
    expect(await ent.getStoredManagerSmsEntitlement(db as never, MANAGER)).toMatchObject({ eligible: false });
  });

  it("drops the exemption the moment the owner row is gone or unreadable", async () => {
    db.tables.platform_service_settings = [];
    expect(await ent.getStoredManagerSmsEntitlement(db as never, OWNER)).toMatchObject({ eligible: false });
    db.tables.platform_service_settings = [{ singleton: true, owner_user_id: OWNER }];
    db.failOn.platform_service_settings = { code: "XX000", message: "boom" };
    expect(await ent.getStoredManagerSmsEntitlement(db as never, OWNER)).toMatchObject({ eligible: false });
  });
});
