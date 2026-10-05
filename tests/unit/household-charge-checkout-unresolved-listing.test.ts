import { beforeEach, describe, expect, it, vi } from "vitest";

const getStripe = vi.hoisted(() => vi.fn());
const resolveByLabel = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  resolveListingForHouseholdCharge: resolveByLabel,
}));

import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const resident = { userId: "resident-1", userEmail: "resident@example.com" };

function fakeDb(propertyDataById: Record<string, unknown>) {
  const chargeIds = Object.keys(propertyDataById).map((propertyId, index) => ({
    id: `charge-${index + 1}`, propertyId,
  }));
  const db = { from(table: string) {
    let id = "";
    const query = {
      select() { return query; },
      eq(key: string, value: string) { if (key === "id") id = value; return query; },
      async maybeSingle() {
        if (table === "portal_household_charge_records") {
          const matched = chargeIds.find((row) => row.id === id);
          return { data: matched ? { id, status: "pending", manager_user_id: "manager-1",
            row_data: { id, status: "pending", propertyId: matched.propertyId,
              propertyLabel: "Shared label", managerUserId: "manager-1",
              residentEmail: resident.userEmail, amountLabel: "$5.00", title: "Rent" } } : null, error: null };
        }
        if (table === "manager_property_records") {
          return { data: propertyDataById[id] == null ? null : {
            manager_user_id: "manager-1", property_data: propertyDataById[id],
          }, error: null };
        }
        throw new Error(`Unexpected payment read: ${table}`);
      },
    };
    return query;
  } };
  return { db, chargeIds: chargeIds.map((row) => row.id) };
}

describe("household checkout listing authority", () => {
  beforeEach(() => {
    getStripe.mockReset();
    resolveByLabel.mockReset().mockResolvedValue(createDefaultListingSubmission());
  });

  it("rejects a missing or malformed owned listing without label fallback or Stripe creation", async () => {
    for (const propertyData of [null, { listingSubmission: { v: 1, rooms: [] } }]) {
      const { db, chargeIds } = fakeDb({ "property-1": propertyData });
      const result = await createHouseholdChargeCheckout(db as never, {
        ...resident, chargeIds, mode: "embedded", paymentMethod: "card",
        appOrigin: "http://localhost:3000",
      });
      expect(result).toMatchObject({ ok: false, code: "UNRESOLVED_LISTING" });
    }
    expect(resolveByLabel).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("rejects an entire cart if any property listing is unresolved", async () => {
    const { db, chargeIds } = fakeDb({
      "property-1": { listingSubmission: createDefaultListingSubmission() },
      "property-2": { listingSubmission: { v: 1, rooms: [] } },
    });
    const result = await createHouseholdChargeCheckout(db as never, {
      ...resident, chargeIds, mode: "embedded", paymentMethod: "card",
      appOrigin: "http://localhost:3000",
    });
    expect(result).toMatchObject({ ok: false, code: "UNRESOLVED_LISTING" });
    expect(getStripe).not.toHaveBeenCalled();
  });
});
