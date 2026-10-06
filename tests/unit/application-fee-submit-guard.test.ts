import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFee = vi.hoisted(() => vi.fn());
const waive = vi.hoisted(() => vi.fn());
vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: resolveFee,
  applicationFeePaymentSatisfiesTemplate: () => true,
  applicationFeeBasisFromSessionMetadata: () => ({ roomId: "", leaseTerm: "", bundleId: "", rentalType: "standard" }),
}));
vi.mock("@/lib/rental-application/application-policy.server", () => ({
  shouldWaiveApplicationFeeForResidentServer: waive,
}));
vi.mock("@/lib/manager-application-settings", () => ({
  loadManagerApplicationSettings: vi.fn(async () => ({ applicationFeeChargePolicy: "first_only" })),
}));

import { authorizeApplicationFeeSubmission } from "@/lib/rental-application/application-fee-submit-guard.server";

function applicant(id: string, waived = false) {
  return { id, propertyId: "property-1", managerUserId: "manager-1", email: "resident@example.com",
    application: { propertyId: "property-1", email: "resident@example.com", applicationFeeWaived: waived } };
}

function database() {
  const claims = new Map<string, Record<string, unknown>>();
  const charges = new Map<string, Record<string, unknown>>();
  const redemptions = new Map<string, boolean>();
  const db = {
    from: vi.fn((table: string) => {
      let applicationId = "";
      const query = {
        select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), limit: vi.fn(),
      };
      query.select.mockReturnValue(query);
      query.eq.mockImplementation((column: string, value: string) => {
        if (column === "application_id" || column === "id") applicationId = value;
        return query;
      });
      query.maybeSingle.mockImplementation(async () => ({
        data: table === "application_fee_payment_claims" ? claims.get(applicationId) ?? null
          : charges.get(applicationId) ?? null, error: null,
      }));
      query.limit.mockImplementation(async () => ({ data: redemptions.get(applicationId) ? [{ id: "waiver-1" }] : [], error: null }));
      return query;
    }),
  };
  return { db, claims, charges, redemptions };
}

describe("server application fee submission authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFee.mockResolvedValue({ ok: true, value: { managerUserId: "manager-1",
      applicationFeeCents: 5000, feeRoomId: "", feeLeaseTerm: "", listing: null } });
    waive.mockResolvedValue(false);
  });

  it("rejects a second every-time draft even when the first has a paid charge", async () => {
    const { db, claims, charges } = database();
    claims.set("app-one", { application_id: "app-one", manager_user_id: "manager-1",
      property_id: "property-1", resident_email: "resident@example.com", status: "settled",
      stripe_session_id: "cs_one", charge_id: "hc_one", principal_cents: 5000,
      provider_params: { metadata: {} } });
    charges.set("hc_one", { id: "hc_one", manager_user_id: "manager-1",
      property_id: "property-1", resident_email: "resident@example.com", kind: "application_fee",
      status: "paid", row_data: { applicationId: "app-one", stripeCheckoutSessionId: "cs_one" } });
    await expect(authorizeApplicationFeeSubmission(db as never, applicant("app-one") as never))
      .resolves.toEqual({ ok: true });
    await expect(authorizeApplicationFeeSubmission(db as never, applicant("app-two") as never))
      .resolves.toMatchObject({ ok: false, status: 409 });
    expect(db.from).toHaveBeenCalledWith("application_fee_payment_claims");
  });

  it("accepts an authoritative first-only waiver and refuses a forged waiver flag", async () => {
    const { db, redemptions } = database();
    waive.mockResolvedValueOnce(true);
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-two") as never)).toEqual({ ok: true });
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-two", true) as never))
      .toMatchObject({ ok: false, status: 409 });
    redemptions.set("app-two", true);
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-two", true) as never))
      .toEqual({ ok: true });
  });

  it("honors a listing every-time override over the manager's first-only default", async () => {
    const { db } = database();
    waive.mockImplementation(async (_db, input) => input.chargePolicy === "first_only");
    resolveFee.mockResolvedValueOnce({ ok: true, value: { managerUserId: "manager-1",
      applicationFeeCents: 5000, feeRoomId: "", feeLeaseTerm: "",
      listing: { waiveApplicationFeeForReturningResidents: false } } });
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-two") as never))
      .toMatchObject({ ok: false, status: 409 });
    resolveFee.mockResolvedValueOnce({ ok: true, value: { managerUserId: "manager-1",
      applicationFeeCents: 5000, feeRoomId: "", feeLeaseTerm: "",
      listing: { waiveApplicationFeeForReturningResidents: true } } });
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-two") as never))
      .toEqual({ ok: true });
  });

  it("fails closed on a fee resolver read failure", async () => {
    resolveFee.mockRejectedValueOnce(new Error("listing unavailable"));
    const { db } = database();
    expect(await authorizeApplicationFeeSubmission(db as never, applicant("app-one") as never))
      .toMatchObject({ ok: false, status: 500 });
  });
  it("allows a valid new no-fee resident submission before its manager is stamped", async () => {
    const { db } = database();
    resolveFee.mockResolvedValueOnce({ ok: true, value: { managerUserId: "manager-1",
      applicationFeeCents: 0, feeRoomId: "", feeLeaseTerm: "", listing: null } });
    const row = { ...applicant("new-app"), managerUserId: null };
    expect(await authorizeApplicationFeeSubmission(db as never, row as never)).toEqual({ ok: true });
    expect(resolveFee).toHaveBeenCalledWith(db, expect.objectContaining({ propertyId: "property-1", managerUserId: "" }),
      { allowZeroFee: true });
  });
});
