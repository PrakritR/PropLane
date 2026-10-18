import { beforeEach, describe, expect, it, vi } from "vitest";

const getStripe = vi.hoisted(() => vi.fn());
const check = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/short-stay/stay-add-ons.server", () => ({
  STAY_ADD_ON_UNAVAILABLE_CODE: "STAY_ADD_ON_UNAVAILABLE",
  checkStayAddOnPayable: check,
}));

import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const resident = { userId: "resident-1", userEmail: "resident@example.com" };

function fakeDb(extra: Record<string, unknown>) {
  return {
    from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          if (table === "portal_household_charge_records") {
            return { data: { id: "hc_mgr_stay_b_early_check_in", status: "pending", manager_user_id: "manager-1",
              row_data: { id: "hc_mgr_stay_b_early_check_in", status: "pending", propertyId: "property-1", propertyLabel: "Cedar", managerUserId: "manager-1",
                residentUserId: "resident-1", residentEmail: resident.userEmail, amountLabel: "$25.00", title: "Early check-in at 12:00 pm", ...extra } }, error: null };
          }
          if (table === "manager_property_records") {
            return { data: { manager_user_id: "manager-1", property_data: { listingSubmission: createDefaultListingSubmission() } }, error: null };
          }
          throw new Error(`Unexpected payment read: ${table}`);
        },
      };
      return query;
    },
  };
}

const run = (extra: Record<string, unknown>) =>
  createHouseholdChargeCheckout(fakeDb(extra) as never, { ...resident, chargeIds: ["hc_mgr_stay_b_early_check_in"], mode: "hosted", paymentMethod: "card", appOrigin: "http://localhost:3000" });

describe("checkout re-checks a stay add-on before any Stripe session exists", () => {
  beforeEach(() => {
    getStripe.mockReset();
    check.mockReset();
  });

  it("an add-on that can no longer be honored is a 409 with its code, and Stripe is never touched", async () => {
    check.mockResolvedValue({ ok: false, retry: false, message: "Early check-in isn't available that day." });
    const result = await run({ stayAddOn: "early_check_in", guestStayBlockId: "b" });
    expect(result).toEqual({ ok: false, status: 409, code: "STAY_ADD_ON_UNAVAILABLE", error: "Early check-in isn't available that day." });
    expect(check).toHaveBeenCalledTimes(1);
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("an unreadable calendar is a 503 and creates nothing", async () => {
    check.mockResolvedValue({ ok: false, retry: true, message: "We couldn't check the calendar right now. Try again in a minute." });
    expect(await run({ stayAddOn: "early_check_in", guestStayBlockId: "b" })).toMatchObject({ ok: false, status: 503 });
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("an ordinary charge never consults the add-on check", async () => {
    await run({}).catch(() => undefined);
    expect(check).not.toHaveBeenCalled();
  });
});
