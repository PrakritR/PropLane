import { beforeEach, describe, expect, it, vi } from "vitest";

const shouldWaive = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/application-fee-checkout.server", () => ({
  APPLICATION_FEE_BASIS_VERSION: "1",
  resolveApplicationFeeProperty: vi.fn(async () => ({ ok: true, value: {
    managerUserId: "manager-1", applicationFeeCents: 5000, listing: {}, resolvedApplicationTemplateId: null,
    feeRoomId: null, feeLeaseTerm: "12 months", feeSource: "listing",
  } })),
  resolveApplicationFeeItemization: vi.fn(),
}));
vi.mock("@/lib/rental-application/application-fee-channel", () => ({ listingApplicationFeeChannels: () => ({ ach: true }) }));
vi.mock("@/lib/manager-application-settings", () => ({ loadManagerApplicationSettings: async () => ({ applicationFeeChargePolicy: "every_time" }) }));
vi.mock("@/lib/rental-application/listing-application-fee-policy", () => ({ resolveApplicationFeeChargePolicy: () => "every_time" }));
vi.mock("@/lib/rental-application/application-policy.server", () => ({ shouldWaiveApplicationFeeForResidentServer: shouldWaive }));

import { applicationFeeCheckoutSourceConflict, createClaimedApplicationFeeCheckout } from "@/lib/application-fee-payment-claim.server";

const input = { applicationId: "application-b", managerUserId: "manager-1", propertyId: "property-1", residentEmail: "resident@example.test" };

function database(rows: Array<{ row_data: Record<string, unknown> }>) {
  const rpc = vi.fn();
  const sourceQuery = {
    eq: () => sourceQuery,
    in: () => sourceQuery,
    order: () => sourceQuery,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  const from = vi.fn((table: string) => ({
    select: (columns: string) => table === "application_fee_payment_claims" && columns === "*"
      ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
      : sourceQuery,
  }));
  return { from, rpc };
}

beforeEach(() => shouldWaive.mockResolvedValue(false));

describe("legacy application-fee checkout guard", () => {
  it("blocks an ambiguous same-resident/property paid source before reserving or creating Checkout", async () => {
    const db = database([{ row_data: { status: "paid", stripeCheckoutSessionId: "cs_test_legacy" } }]);
    const create = vi.fn();
    const stripe = { checkout: { sessions: { create } } };
    const result = await createClaimedApplicationFeeCheckout(db as never, stripe as never, {
      ...input, draftUpdatedAt: "2026-10-05T00:00:00Z", mode: "embedded", returnUrl: "https://example.test/return",
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: "APPLICATION_FEE_NEEDS_REVIEW" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not borrow sibling application A's exact paid source for B", async () => {
    const db = database([{ row_data: { applicationId: "application-a", status: "paid", stripeCheckoutSessionId: "cs_test_a" } }]);
    expect(await applicationFeeCheckoutSourceConflict(db as never, input)).toBeNull();
  });

  it("blocks an already-paid exact application before a second attempt", async () => {
    const db = database([{ row_data: { applicationId: "application-b", status: "paid", stripeCheckoutSessionId: "cs_test_b" } }]);
    expect(await applicationFeeCheckoutSourceConflict(db as never, input)).toBe("exact_paid");
  });

  it("lets an authoritative first-only waiver bypass a second Checkout", async () => {
    shouldWaive.mockResolvedValueOnce(true);
    const db = database([{ row_data: { status: "paid", stripeCheckoutSessionId: "cs_test_legacy" } }]);
    const result = await createClaimedApplicationFeeCheckout(db as never, {} as never, {
      ...input, draftUpdatedAt: "2026-10-05T00:00:00Z", mode: "embedded", returnUrl: "https://example.test/return",
    });
    expect(result).toMatchObject({ ok: false, code: "APPLICATION_FEE_WAIVED" });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
