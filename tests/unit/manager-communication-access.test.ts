/**
 * The server rule for "may this workspace's manager communicate?" - driven through the REAL plan
 * read (`getEffectiveManagerSkuTier` over a fake `manager_purchases`), so the trial, lapsed-trial,
 * Stripe, waiver and grant verdicts are the ones the product actually enforces, not a mock's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type PurchaseRow = Record<string, unknown>;
const state = vi.hoisted(() => ({
  purchases: [] as PurchaseRow[],
  purchaseError: false,
  workspaces: new Map<string, string>(),
  workspaceError: false,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === "profiles") return { data: { email: "mgr@example.com" }, error: null };
        if (table === "manager_purchases") {
          return state.purchaseError
            ? { data: null, error: { message: "boom" } }
            : { data: state.purchases, error: null };
        }
        return { data: [], error: null };
      };
      for (const m of ["select", "eq", "ilike", "in", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => result();
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return chain;
    },
  }),
}));
vi.mock("@/lib/manager-id", () => ({ generateManagerId: () => "mgr_id" }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: async () => null }));
vi.mock("@/lib/payment-policy", () => ({ resolveServiceFeePayerFor: () => "resident" }));

import {
  MANAGER_COMMUNICATION_TRIAL_MESSAGE,
  assertManagerCommunicationAllowed,
  assertManagerCommunicationAllowedForWorkspace,
  resolveCommunicationOwnerId,
} from "@/lib/manager-communication-access.server";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const row = (over: PurchaseRow): PurchaseRow => ({
  id: "p1",
  user_id: "owner-1",
  tier: "pro",
  billing: "trial",
  paid_at: daysAgo(2),
  stripe_customer_id: null,
  stripe_subscription_id: null,
  stripe_checkout_session_id: null,
  promo_code: null,
  apple_original_transaction_id: null,
  ...over,
});

beforeEach(() => {
  state.purchases = [];
  state.purchaseError = false;
  state.workspaces = new Map();
  state.workspaceError = false;
});

describe("assertManagerCommunicationAllowed", () => {
  it("refuses a live signup trial with 402 and the paid-plan message", async () => {
    state.purchases = [row({})];
    const result = await assertManagerCommunicationAllowed("owner-1");
    expect(result).toEqual({
      allowed: false,
      reason: "trial",
      status: 402,
      message: MANAGER_COMMUNICATION_TRIAL_MESSAGE,
    });
    expect(MANAGER_COMMUNICATION_TRIAL_MESSAGE).toBe("Communication is available on a paid plan.");
  });

  it("refuses a Business trial the same way", async () => {
    state.purchases = [row({ tier: "business" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toMatchObject({ allowed: false, reason: "trial" });
  });

  it("leaves a LAPSED trial on Free's behaviour: allowed", async () => {
    state.purchases = [row({ paid_at: daysAgo(30) })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("allows a Stripe-paid manager", async () => {
    state.purchases = [row({ billing: "monthly", stripe_subscription_id: "sub_1" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("allows a manager on a payment-waiver promo code (a waiver IS paid), even on a trial-shaped row", async () => {
    state.purchases = [row({ billing: "monthly", promo_code: "FREE100" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
    state.purchases = [row({ promo_code: "FREE100" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("allows an admin or portal grant", async () => {
    state.purchases = [row({ billing: "admin", stripe_checkout_session_id: "admin_portal_pro_owner-1" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
    state.purchases = [row({ billing: "portal" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("allows an Apple-billed manager", async () => {
    state.purchases = [row({ billing: "apple", apple_original_transaction_id: "1000000123" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("keeps Free as it is: a Free account and an account with no purchase row are allowed", async () => {
    state.purchases = [row({ tier: "free", billing: "free" })];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
    state.purchases = [];
    expect(await assertManagerCommunicationAllowed("owner-1")).toEqual({ allowed: true });
  });

  it("fails closed when the plan cannot be read - 503, never 'probably paid'", async () => {
    state.purchases = [row({ billing: "monthly", stripe_subscription_id: "sub_1" })];
    state.purchaseError = true;
    expect(await assertManagerCommunicationAllowed("owner-1")).toMatchObject({
      allowed: false,
      reason: "plan_unreadable",
      status: 503,
    });
  });

  it("fails closed on an empty owner id", async () => {
    expect(await assertManagerCommunicationAllowed("  ")).toMatchObject({ allowed: false, reason: "plan_unreadable" });
  });
});

describe("a teammate acting in someone else's workspace", () => {
  const dbFor = (owners: Record<string, string>, fail = false) =>
    ({
      from: () => ({
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () =>
              fail
                ? { data: null, error: { message: "boom" } }
                : { data: owners[id] ? { owner_user_id: owners[id] } : null, error: null },
          }),
        }),
      }),
    }) as never;

  it("resolves the workspace owner, and the actor themself when no workspace is named", async () => {
    expect(await resolveCommunicationOwnerId(dbFor({ ws1: "owner-1" }), "mate-1", "ws1")).toBe("owner-1");
    expect(await resolveCommunicationOwnerId(dbFor({}), "mate-1", null)).toBe("mate-1");
    expect(await resolveCommunicationOwnerId(dbFor({}), "mate-1", "unknown-ws")).toBeNull();
    expect(await resolveCommunicationOwnerId(dbFor({}, true), "mate-1", "ws1")).toBeNull();
  });

  it("is refused in a trial owner's workspace, whatever the teammate's own plan", async () => {
    state.purchases = [row({ user_id: "owner-1" })];
    const result = await assertManagerCommunicationAllowedForWorkspace(dbFor({ ws1: "owner-1" }), "mate-1", "ws1");
    expect(result).toMatchObject({ allowed: false, reason: "trial", status: 402 });
  });

  it("is allowed in a paid owner's workspace", async () => {
    state.purchases = [row({ billing: "monthly", stripe_subscription_id: "sub_1" })];
    expect(await assertManagerCommunicationAllowedForWorkspace(dbFor({ ws1: "owner-1" }), "mate-1", "ws1")).toEqual({
      allowed: true,
    });
  });

  it("is refused when the workspace owner cannot be determined", async () => {
    expect(await assertManagerCommunicationAllowedForWorkspace(dbFor({}), "mate-1", "ghost")).toMatchObject({
      allowed: false,
      reason: "plan_unreadable",
      status: 503,
    });
  });
});
