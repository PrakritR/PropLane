import { beforeEach, describe, expect, it, vi } from "vitest";

const getStripe = vi.hoisted(() => vi.fn());
const loadResidentChargeActionBinding = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/resident-charge-binding.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resident-charge-binding.server")>()),
  loadResidentChargeActionBinding,
}));

import { loadHouseholdChargesForCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { chargeRowActionableByResident } from "@/lib/resident-charge-binding.server";

/** A phone sign-up resident: their sign-in address is the placeholder, never the application's address. */
const phoneResident = { userId: "resident-1", userEmail: "0f3a@phone.proplane.invalid" };

function fakeDb(charge: { residentUserId?: string | null; residentEmail: string; applicationId?: string }) {
  return { from(table: string) {
    const query = {
      select() { return query; },
      eq() { return query; },
      async maybeSingle() {
        if (table === "portal_household_charge_records") {
          return { data: { id: "charge-1", status: "pending", manager_user_id: "manager-1",
            resident_user_id: charge.residentUserId ?? null, resident_email: charge.residentEmail,
            row_data: { id: "charge-1", status: "pending", managerUserId: "manager-1", residentEmail: charge.residentEmail,
              ...(charge.residentUserId ? { residentUserId: charge.residentUserId } : {}),
              ...(charge.applicationId ? { applicationId: charge.applicationId } : {}),
              amountLabel: "$650.00", title: "Security deposit" } }, error: null };
        }
        // Ownership is decided before any payee read: reaching one means the charge was accepted as theirs.
        throw new Error(`PAST_OWNERSHIP:${table}`);
      },
    };
    return query;
  } };
}

describe("checkout follows the resident's bound application", () => {
  beforeEach(() => {
    getStripe.mockReset();
    loadResidentChargeActionBinding.mockReset();
  });

  it("lets a phone sign-up resident pay an approval charge keyed to their own application", async () => {
    loadResidentChargeActionBinding.mockResolvedValue({ applicationIds: ["PROPLANE-ABC"], managerEmails: [] });
    await expect(loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "ava@example.com", applicationId: "PROPLANE-ABC" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    })).rejects.toThrow("PAST_OWNERSHIP");
    expect(loadResidentChargeActionBinding).toHaveBeenCalledWith(expect.anything(), "resident-1");
  });

  it("still refuses a charge pinned to another resident, or one no bound application names", async () => {
    loadResidentChargeActionBinding.mockResolvedValue({ applicationIds: ["PROPLANE-ABC"], managerEmails: [{ managerUserId: "manager-1", email: "ava@example.com" }] });
    const pinned = await loadHouseholdChargesForCheckout(fakeDb({ residentUserId: "resident-2", residentEmail: "ava@example.com", applicationId: "PROPLANE-ABC" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    });
    expect(pinned).toMatchObject({ ok: false, status: 403 });
    const unbound = await loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "bo@example.com" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    });
    expect(unbound).toMatchObject({ ok: false, status: 403 });
    expect(getStripe).not.toHaveBeenCalled();
  });

  /**
   * The address a manager keyed a charge to is typed by the applicant, so it is a READ heuristic only: a phone
   * sign-up account owns its application row whatever mailbox it writes there, and the shared-address drop cannot
   * see a victim who has no application of their own. Paying never rests on it.
   */
  it("refuses a manager-entered charge the binding reaches only by its address", async () => {
    loadResidentChargeActionBinding.mockResolvedValue({ applicationIds: [], managerEmails: [{ managerUserId: "manager-1", email: "ava@example.com" }] });
    const addressOnly = await loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "ava@example.com" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    });
    expect(addressOnly).toMatchObject({ ok: false, status: 403 });
    expect(getStripe).not.toHaveBeenCalled();
  });
});

describe("chargeRowActionableByResident", () => {
  const binding = { applicationIds: ["APP-1"], managerEmails: [{ managerUserId: "m1", email: "ava@example.com" }] };
  it("takes only an unpinned row naming one of the subject's own applications", () => {
    expect(chargeRowActionableByResident({ residentUserId: null, applicationId: "APP-1" }, binding)).toBe(true);
    expect(chargeRowActionableByResident({ residentUserId: "someone", applicationId: "APP-1" }, binding)).toBe(false);
    expect(chargeRowActionableByResident({ residentUserId: null, applicationId: "" }, binding)).toBe(false);
    expect(chargeRowActionableByResident({ residentUserId: null, applicationId: "APP-2" }, binding)).toBe(false);
    expect(chargeRowActionableByResident({ residentUserId: null, applicationId: "APP-1" }, { applicationIds: [], managerEmails: [] })).toBe(false);
  });
});
