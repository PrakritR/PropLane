// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { shortStayPricingBlocker, SHORT_STAY_PRICING_INCOMPLETE_MESSAGE } from "@/lib/short-stay-pricing-gate";
import { shortStayApprovalBlocker } from "@/lib/short-stay-pricing-gate.server";
import { leaseSendGateBlockerAmong, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";

function listing(nightly = "") {
  const base = createDefaultListingSubmission();
  return normalizeManagerListingSubmissionV1({ ...base, shortTermRentalsAllowed: true, shortTermDailyCost: "", rooms: [{ ...base.rooms[0]!, id: "room", shortTermRent: nightly, dailyRentPrice: undefined, weeklyRentPrice: 350 }] });
}
function app(leaseEnd = "2027-10-09"): DemoApplicantRow {
  return { id: "AXIS-STAY", managerUserId: "owner", propertyId: "house", bucket: "approved", stage: "Approved", name: "Ava Lee", email: "ava@example.com", application: { rentalType: "short_term", roomChoice1: "house::room", leaseStart: "2027-10-01", leaseEnd } } as DemoApplicantRow;
}
function lease(application = app().application): LeasePipelineRow {
  return { id: "lease", axisId: "AXIS-STAY", propertyId: "house", residentName: "Ava Lee", residentEmail: "ava@example.com", unit: "House", bucket: "manager", stageLabel: "Manager Review", status: "Manager Review", updated: "", updatedAtIso: "2026-10-25", notes: "", pdfVersion: 1, thread: [], generatedHtml: "<p>Stay agreement</p>", application };
}

describe("short-stay pricing approval and send boundary", () => {
  it("refuses an eight-night weekly-only stay and allows seven nights or a nightly rate", () => {
    expect(shortStayPricingBlocker(app(), listing())).toBe(SHORT_STAY_PRICING_INCOMPLETE_MESSAGE);
    expect(leaseSendGateBlockerAmong(lease(), [app()], listing())).toBe(SHORT_STAY_PRICING_INCOMPLETE_MESSAGE);
    expect(leaseSendGateBlockerAmong(lease(app("2027-10-08").application), [app()], listing())).toBeNull();
    expect(leaseSendGateBlockerAmong(lease(), [app()], listing("55"))).toBeNull();
  });
  it.each(["2027-10-01", "2027-09-30"])("rejects a non-positive stay ending %s instead of clamping it to a night", (end) => {
    expect(shortStayPricingBlocker(app(end), listing("55"))).toMatch(/valid check-in and check-out dates/);
  });
  it("uses the selected resident's own rate instead of another slot's nightly rate", () => {
    const sub = listing("55");
    sub.rooms[0] = { ...sub.rooms[0]!, stayResidentPricing: "per_resident", occupancyCapacity: 2, stayResidentPrices: [{ shortTermRent: "55" }, { shortTermRent: "", weeklyRentPrice: 350 }] };
    const row = app();
    row.application!.roomChoice1 = "house::room::r2";
    // The room headline still supplies a fallback nightly rate; remove it to make slot 2 weekly-only.
    sub.rooms[0].shortTermRent = "";
    expect(shortStayPricingBlocker(row, sub)).toBe(SHORT_STAY_PRICING_INCOMPLETE_MESSAGE);
  });
  it("preserves signed history and does not recheck existing approved metadata writes", async () => {
    const signed = { ...lease(), residentSignature: { signedAtIso: "2026-10-20", name: "Ava Lee" } } as LeasePipelineRow;
    expect(leaseSendGateBlockerAmong(signed, [app()], null)).toBeNull();
    const db = { from: vi.fn() };
    expect(await shortStayApprovalBlocker(db as unknown as SupabaseClient, app(), app())).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });
  it("fails closed if the owning property's pricing cannot be loaded", async () => {
    const eq = vi.fn().mockReturnThis();
    const db = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnThis(), eq, maybeSingle: async () => ({ data: null, error: { message: "offline" } }) }) };
    expect(await shortStayApprovalBlocker(db as unknown as SupabaseClient, app(), null)).toMatch(/Could not verify/);
    expect(eq).toHaveBeenCalledWith("manager_user_id", "owner");
    expect(eq).toHaveBeenCalledWith("id", "house");
  });
});
