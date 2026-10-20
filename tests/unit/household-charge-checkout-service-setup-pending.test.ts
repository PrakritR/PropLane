import { beforeEach, describe, expect, it, vi } from "vitest";

const getStripe = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/managed-finance/resolve.server", () => ({ managedCartProblem: async () => null }));
vi.mock("@/lib/managed-finance/unpolicied-service.server", () => ({ serviceSetupPendingProblem: pending }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));

import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const resident = { userId: "resident-1", userEmail: "resident@example.com" };

function fakeDb() {
  return { from(table: string) {
    let id = "";
    const query = {
      select() { return query; },
      eq(key: string, value: string) { if (key === "id") id = value; return query; },
      async maybeSingle() {
        if (table === "portal_household_charge_records") {
          return { data: { id, status: "pending", manager_user_id: "manager-1",
            row_data: { id, status: "pending", propertyId: "property-1", propertyLabel: "Maple Court", managerUserId: "manager-1",
              residentEmail: resident.userEmail, amountLabel: "$500.00", title: "Rent" } }, error: null };
        }
        if (table === "manager_property_records") {
          return { data: { manager_user_id: "manager-1", property_data: { listingSubmission: createDefaultListingSubmission() } }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return query;
  } };
}

describe("a resident cannot start a checkout for a service workspace whose fee agreement is unsigned", () => {
  beforeEach(() => {
    getStripe.mockReset();
    pending.mockReset();
  });

  it("answers 422 SERVICE_SETUP_PENDING with the setup message and never creates a Stripe session", async () => {
    pending.mockResolvedValue({ code: "SERVICE_SETUP_PENDING", message: "Payments for this home are being set up. Your manager will text you a link shortly." });
    const result = await createHouseholdChargeCheckout(fakeDb() as never, {
      ...resident, chargeIds: ["charge-1"], mode: "embedded", paymentMethod: "card", appOrigin: "http://localhost:3000",
    });
    expect(result).toMatchObject({ ok: false, status: 422, code: "SERVICE_SETUP_PENDING" });
    expect((result as { error: string }).error).toContain("being set up");
    expect(pending).toHaveBeenCalledWith(expect.anything(), ["property-1"]);
    expect(getStripe).not.toHaveBeenCalled();
  });
});
