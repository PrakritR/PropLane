import { beforeEach, describe, expect, it, vi } from "vitest";

const getStripe = vi.hoisted(() => vi.fn());
const loadResidentChargeBinding = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/resident-charge-binding.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resident-charge-binding.server")>()),
  loadResidentChargeBinding,
}));

import { loadHouseholdChargesForCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { chargeRowBoundToResident } from "@/lib/resident-charge-binding.server";

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

describe("checkout follows the resident's bound charges", () => {
  beforeEach(() => {
    getStripe.mockReset();
    loadResidentChargeBinding.mockReset();
  });

  it("lets a phone sign-up resident pay an approval charge keyed to their own application", async () => {
    loadResidentChargeBinding.mockResolvedValue({ applicationIds: ["PROPLANE-ABC"], managerEmails: [] });
    await expect(loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "ava@example.com", applicationId: "PROPLANE-ABC" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    })).rejects.toThrow("PAST_OWNERSHIP");
    expect(loadResidentChargeBinding).toHaveBeenCalledWith(expect.anything(), "resident-1");
  });

  it("lets them pay a manager-entered charge for their application's own (unshared) address", async () => {
    loadResidentChargeBinding.mockResolvedValue({ applicationIds: [], managerEmails: [{ managerUserId: "manager-1", email: "ava@example.com" }] });
    await expect(loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "ava@example.com" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    })).rejects.toThrow("PAST_OWNERSHIP");
  });

  it("still refuses a charge pinned to another resident, or one the binding does not reach", async () => {
    loadResidentChargeBinding.mockResolvedValue({ applicationIds: ["PROPLANE-ABC"], managerEmails: [{ managerUserId: "manager-1", email: "ava@example.com" }] });
    const pinned = await loadHouseholdChargesForCheckout(fakeDb({ residentUserId: "resident-2", residentEmail: "ava@example.com", applicationId: "PROPLANE-ABC" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    });
    expect(pinned).toMatchObject({ ok: false, status: 403 });
    loadResidentChargeBinding.mockResolvedValue({ applicationIds: [], managerEmails: [] });
    const unbound = await loadHouseholdChargesForCheckout(fakeDb({ residentEmail: "bo@example.com" }) as never, {
      ...phoneResident, chargeIds: ["charge-1"],
    });
    expect(unbound).toMatchObject({ ok: false, status: 403 });
    expect(getStripe).not.toHaveBeenCalled();
  });
});

describe("chargeRowBoundToResident", () => {
  const binding = { applicationIds: ["APP-1"], managerEmails: [{ managerUserId: "m1", email: "ava@example.com" }] };
  it("matches the same two shapes as the Payments read, and only on rows with no resident id", () => {
    expect(chargeRowBoundToResident({ residentUserId: null, managerUserId: "x", residentEmail: "", applicationId: "APP-1" }, binding)).toBe(true);
    expect(chargeRowBoundToResident({ residentUserId: null, managerUserId: "m1", residentEmail: "AVA@example.com", applicationId: "" }, binding)).toBe(true);
    expect(chargeRowBoundToResident({ residentUserId: "someone", managerUserId: "m1", residentEmail: "ava@example.com", applicationId: "APP-1" }, binding)).toBe(false);
    expect(chargeRowBoundToResident({ residentUserId: null, managerUserId: "m2", residentEmail: "ava@example.com", applicationId: "" }, binding)).toBe(false);
    expect(chargeRowBoundToResident({ residentUserId: null, managerUserId: "m1", residentEmail: "ava@example.com", applicationId: "" }, { applicationIds: [], managerEmails: [] })).toBe(false);
  });
});
