import { describe, expect, it } from "vitest";
import { agreementActiveOn, decideOwnerRouting, type OwnerAgreementFacts } from "@/lib/owner-management/routing";

const agreement = (over: Partial<OwnerAgreementFacts> = {}): OwnerAgreementFacts => ({
  id: "ag1",
  propertyId: "p1",
  managerUserId: "m1",
  ownerUserId: "o1",
  status: "active",
  startsOn: "2026-10-01",
  endsOn: null,
  terms: {
    feeModel: "percent_of_collected", feeBps: 800, feeFlatCents: 0, leasingFeeBps: 0, minFeeCents: 0,
    repairApprovalThresholdCents: 25_000, reserveTargetCents: 0,
  },
  ...over,
});

const base = { chargeKinds: ["rent"], todayPacific: "2026-10-18", readyDestinationAccountId: "acct_owner" };

describe("decideOwnerRouting", () => {
  it("no agreement keeps today's flow", () => {
    expect(decideOwnerRouting({ ...base, agreement: null })).toEqual({ kind: "none", reason: "no_agreement" });
  });
  it("a draft or ended agreement keeps today's flow", () => {
    expect(decideOwnerRouting({ ...base, agreement: agreement({ status: "draft" }) }).kind).toBe("none");
    expect(decideOwnerRouting({ ...base, agreement: agreement({ status: "ended" }) }).kind).toBe("none");
  });
  it("an agreement outside its dates keeps today's flow", () => {
    expect(decideOwnerRouting({ ...base, agreement: agreement({ startsOn: "2026-10-19" }) }).kind).toBe("none");
    expect(decideOwnerRouting({ ...base, agreement: agreement({ endsOn: "2026-10-17" }) }).kind).toBe("none");
    expect(agreementActiveOn(agreement({ endsOn: "2026-10-18" }), "2026-10-18")).toBe(true);
  });
  it("an active agreement with a ready owner is a destination charge to that account", () => {
    const d = decideOwnerRouting({ ...base, agreement: agreement() });
    expect(d).toMatchObject({ kind: "owner_destination", destinationAccountId: "acct_owner" });
  });
  it("an owner who is not payout-ready is held, never routed elsewhere", () => {
    expect(decideOwnerRouting({ ...base, agreement: agreement(), readyDestinationAccountId: null })).toMatchObject({ kind: "held", reason: "owner_not_ready" });
    expect(decideOwnerRouting({ ...base, agreement: agreement(), readyDestinationAccountId: "  ", ownerHasNoAccount: true })).toMatchObject({ kind: "held", reason: "owner_account_missing" });
  });
  it("every routed rent kind routes", () => {
    for (const kind of ["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent"]) {
      expect(decideOwnerRouting({ ...base, agreement: agreement(), chargeKinds: [kind] }).kind).toBe("owner_destination");
    }
  });
  it("a deposit-only or fee-only cart keeps today's flow", () => {
    expect(decideOwnerRouting({ ...base, agreement: agreement(), chargeKinds: ["security_deposit"] })).toEqual({ kind: "none", reason: "no_routed_kinds" });
    expect(decideOwnerRouting({ ...base, agreement: agreement(), chargeKinds: ["application_fee", "late_fee"] }).kind).toBe("none");
  });
  it("a cart mixing rent with a deposit is refused", () => {
    const d = decideOwnerRouting({ ...base, agreement: agreement(), chargeKinds: ["rent", "security_deposit"] });
    expect(d).toMatchObject({ kind: "refuse", status: 422, code: "MIXED_OWNER_ROUTING" });
  });
  it("autopay on a routed house is refused, not silently split", () => {
    const d = decideOwnerRouting({ ...base, agreement: agreement(), autopay: true });
    expect(d).toMatchObject({ kind: "refuse", code: "OWNER_AUTOPAY_UNSUPPORTED" });
  });
  it("autopay on a house with no agreement is untouched", () => {
    expect(decideOwnerRouting({ ...base, agreement: null, autopay: true }).kind).toBe("none");
  });
});
