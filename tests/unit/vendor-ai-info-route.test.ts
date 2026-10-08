// Vendor AI info (Oct 8): stored on the vendor's own business profile, written only through the
// business-profile route with the service role pinned to the authenticated vendor; validated server-side.
// The same route's Finish hook gives the vendor their number, from the server, never from the body.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  provision: vi.fn(),
  db: null as unknown,
}));
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: mocks.resolveVendorPortalUserId }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/vendor-work-number-signup.server", () => ({ provisionVendorWorkNumberAtSignup: mocks.provision }));
vi.mock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecords: async () => [] }));

import { GET, PATCH } from "@/app/api/vendor/business-profile/route";
import { VENDOR_AI_INFO_MAX_LENGTH, parseVendorAiInfoPatch, readVendorAiInfo } from "@/lib/vendor-ai-info";

let db: FakeDb;
const patch = (body: unknown) => PATCH(jsonRequest("http://test/api/vendor/business-profile", { method: "PATCH", body }));
const rowFor = (userId: string) => db.tables.vendor_business_profiles!.find((r) => r.user_id === userId);

beforeEach(() => {
  vi.clearAllMocks();
  db = createFakeDb({
    vendor_business_profiles: [
      { user_id: "vendor-2", business_name: "Other Plumbing", ai_info: { hours: "Other hours" } },
    ],
  });
  mocks.db = db;
  mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
  mocks.provision.mockResolvedValue({ status: "provisioned", phoneNumber: "+12065550177" });
});

describe("the AI info value", () => {
  it("keeps only the five known keys, as trimmed text within the cap", () => {
    expect(readVendorAiInfo({ hours: "  9-5  ", rates: 5, nope: "x", extra: "y".repeat(2000) })).toEqual({
      hours: "9-5", rates: "", how_to_book: "", emergency: "", extra: "y".repeat(VENDOR_AI_INFO_MAX_LENGTH),
    });
    expect(parseVendorAiInfoPatch({ hours: "9-5", userId: "vendor-2" })).toEqual({ ok: true, patch: { hours: "9-5" } });
  });
});

describe("PATCH /api/vendor/business-profile with aiInfo", () => {
  it("saves on the authenticated vendor's own row and never on a user id from the body", async () => {
    const res = await patch({
      userId: "vendor-2", user_id: "vendor-2", vendorUserId: "vendor-2",
      aiInfo: { hours: "Mon-Fri 8-6", rates: "$95 call", how_to_book: "Text the address", emergency: "Call me", extra: "Parking is free", userId: "vendor-2" },
    });
    const { status, data } = await parseJsonResponse<{ profile: { aiInfo: Record<string, string> } }>(res);
    expect(status).toBe(200);
    expect(data.profile.aiInfo).toEqual({ hours: "Mon-Fri 8-6", rates: "$95 call", how_to_book: "Text the address", emergency: "Call me", extra: "Parking is free" });
    expect(rowFor("vendor-1")?.ai_info).toEqual(data.profile.aiInfo);
    expect(rowFor("vendor-2")?.ai_info).toEqual({ hours: "Other hours" });
  });

  it("merges a partial patch and leaves the other answers alone", async () => {
    await patch({ aiInfo: { hours: "Mon-Fri 8-6", rates: "$95 call" } });
    await patch({ aiInfo: { rates: "$120 call" } });
    expect(rowFor("vendor-1")?.ai_info).toMatchObject({ hours: "Mon-Fri 8-6", rates: "$120 call" });
  });

  it("rejects a non-text answer and an over-long one with a 400 and stores nothing", async () => {
    const tooLong = await parseJsonResponse(await patch({ aiInfo: { hours: "x".repeat(VENDOR_AI_INFO_MAX_LENGTH + 1) } }));
    const notText = await parseJsonResponse(await patch({ aiInfo: { rates: 95 } }));
    const notObject = await parseJsonResponse(await patch({ aiInfo: "hours" }));
    expect([tooLong.status, notText.status, notObject.status]).toEqual([400, 400, 400]);
    expect(rowFor("vendor-1")).toBeUndefined();
  });

  it("401s an unauthenticated caller and writes nothing", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    const { status } = await parseJsonResponse(await patch({ aiInfo: { hours: "x" } }));
    expect(status).toBe(401);
    expect(db.tables.vendor_business_profiles).toHaveLength(1);
  });

  it("GET returns only the signed-in vendor's AI info", async () => {
    await patch({ aiInfo: { hours: "Mine" } });
    const { data } = await parseJsonResponse<{ profile: { aiInfo: { hours: string } } }>(await GET());
    expect(data.profile.aiInfo.hours).toBe("Mine");
  });
});

describe("onboarding Finish gives the vendor a number, from the server", () => {
  const complete = { businessName: "Apex Plumbing", trades: ["Plumbing"], serviceArea: "Seattle", serviceAreaZips: ["98101"] };

  it("provisions once on Finish for the authenticated vendor, and returns the result", async () => {
    const res = await patch({ ...complete, finishOnboarding: true });
    const { status, data } = await parseJsonResponse<{ workNumber?: { status: string; phoneNumber: string } }>(res);
    expect(status).toBe(200);
    expect(data.workNumber).toEqual({ status: "provisioned", phoneNumber: "+12065550177" });
    expect(mocks.provision).toHaveBeenCalledTimes(1);
    expect(mocks.provision).toHaveBeenCalledWith(db, "vendor-1", { serviceAreaZips: ["98101"] });
  });

  it("takes no number from the client: a phoneNumber or claimToken in the body is never passed on", async () => {
    await patch({ ...complete, finishOnboarding: true, phoneNumber: "+19995550100", claimToken: "x", workNumber: "+19995550100" });
    expect(JSON.stringify(mocks.provision.mock.calls)).not.toContain("9995550100");
    expect(mocks.provision.mock.calls[0]).toHaveLength(3);
  });

  it("does not provision on a plain Save, or before the onboarding minimum is filled", async () => {
    await patch({ ...complete });
    expect(mocks.provision).not.toHaveBeenCalled();
    // A different vendor whose minimum (business, trade, area) is not filled cannot trigger it by flag alone.
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-3" });
    await patch({ finishOnboarding: true, businessName: "Half Done" });
    expect(mocks.provision).not.toHaveBeenCalled();
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
    const { data } = await parseJsonResponse<{ workNumber?: unknown }>(await patch({ aiInfo: { hours: "x" } }));
    expect(data.workNumber).toBeUndefined();
  });

  it("a soft-failed provision still saves the profile and completes signup", async () => {
    mocks.provision.mockResolvedValue({ status: "failed" });
    const { status, data } = await parseJsonResponse<{ profile: { businessName: string }; workNumber: { status: string } }>(
      await patch({ ...complete, finishOnboarding: true }),
    );
    expect(status).toBe(200);
    expect(data.profile.businessName).toBe("Apex Plumbing");
    expect(data.workNumber).toEqual({ status: "failed" });
  });
});
