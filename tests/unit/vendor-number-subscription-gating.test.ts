// PropLane Number, vendor side (Oct 8): with NUMBER_SUBSCRIPTION_ENABLED on, a vendor number is for a subscriber
// (numberServiceEntitled: active | past_due) - the claim routes, the signup provisioning and the activation
// auto-provision all refuse otherwise. With the flag off every one of them behaves exactly as it did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type Row } from "../helpers/fake-table-db";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

const mocks = vi.hoisted(() => ({
  entitled: vi.fn(),
  getActiveVendorNumber: vi.fn(),
  loadVendorVerifiedPhone: vi.fn(),
  searchVendorWorkNumberCandidates: vi.fn(),
  setupVendorWorkIdentity: vi.fn(),
  getVendorWorkIdentity: vi.fn(),
  resolveVendorPortalUserId: vi.fn(),
  createVendorWorkIdentityProvider: vi.fn(() => ({ tag: "provider" })),
}));
vi.mock("@/lib/number-subscription/subscription.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/number-subscription/subscription.server")>()),
  numberServiceEntitled: mocks.entitled,
}));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  getActiveVendorNumber: mocks.getActiveVendorNumber,
  loadVendorVerifiedPhone: mocks.loadVendorVerifiedPhone,
  searchVendorWorkNumberCandidates: mocks.searchVendorWorkNumberCandidates,
  setupVendorWorkIdentity: mocks.setupVendorWorkIdentity,
  getVendorWorkIdentity: mocks.getVendorWorkIdentity,
  setVendorForwardToPhone: vi.fn(),
  createVendorWorkIdentityProvider: mocks.createVendorWorkIdentityProvider,
}));
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: mocks.resolveVendorPortalUserId }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ tag: "service-db" }) }));

import { provisionVendorWorkNumberAtSignup, vendorSignupIdempotencyKey } from "@/lib/vendor-work-number-signup.server";
import { provisionVendorNumberOnActivation } from "@/lib/number-subscription/vendor-number-activation.server";
import { POST as claim } from "@/app/api/vendor/work-identity/route";
import { POST as candidates } from "@/app/api/vendor/work-identity/candidates/route";
import { signVendorWorkNumberClaim } from "@/lib/vendor-work-number-claim-token.server";

const db = { tag: "db" } as unknown as SupabaseClient;
const provider = { tag: "provider" } as never;
const KEY = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  mocks.entitled.mockResolvedValue(false);
  mocks.getActiveVendorNumber.mockResolvedValue(null);
  mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: true, phone: "+12065550142" });
  mocks.searchVendorWorkNumberCandidates.mockResolvedValue(["+12065550177"]);
  mocks.setupVendorWorkIdentity.mockResolvedValue({ sms: { state: "ready", value: "+12065550177" } });
  mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("signup provisioning", () => {
  it("flag off: today's free number, and the subscription is never consulted", async () => {
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider });
    expect(result).toEqual({ status: "provisioned", phoneNumber: "+12065550177" });
    expect(mocks.entitled).not.toHaveBeenCalled();
  });

  it("flag on, not entitled: nothing is searched or bought", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider });
    expect(result).toEqual({ status: "skipped", reason: "subscription_required" });
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
    expect(mocks.entitled).toHaveBeenCalledWith("vendor-1", db);
  });

  it("flag on, entitled: provisions through the same gated setup", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    mocks.entitled.mockResolvedValue(true);
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider });
    expect(result).toEqual({ status: "provisioned", phoneNumber: "+12065550177" });
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledTimes(1);
  });

  it("a subscription seed gives a distinct key per subscription; no seed keeps the signup key", () => {
    expect(vendorSignupIdempotencyKey("vendor-1", "sub_a")).not.toBe(vendorSignupIdempotencyKey("vendor-1"));
    expect(vendorSignupIdempotencyKey("vendor-1", "sub_a")).toBe(vendorSignupIdempotencyKey("vendor-1", "sub_a"));
    expect(vendorSignupIdempotencyKey("vendor-1", "sub_a")).not.toBe(vendorSignupIdempotencyKey("vendor-1", "sub_b"));
  });
});

describe("POST /api/vendor/work-identity (SMS claim) and /candidates", () => {
  const claimBody = () => ({
    channel: "sms",
    idempotencyKey: KEY,
    phoneNumber: "+12065550101",
    claimToken: signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" }),
  });
  const post = (body: unknown) => claim(jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body }));

  it("flag off: the claim goes through and the subscription is never read", async () => {
    const res = await post(claimBody());
    expect(res.status).toBe(200);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.entitled).not.toHaveBeenCalled();
  });

  it("flag on, not subscribed: 403 subscription_required and nothing is purchased", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    const { status, data } = await parseJsonResponse<{ code: string }>(await post(claimBody()));
    expect(status).toBe(403);
    expect(data.code).toBe("subscription_required");
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("flag on, subscribed: the claim proceeds", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    mocks.entitled.mockResolvedValue(true);
    expect((await post(claimBody())).status).toBe(200);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledTimes(1);
  });

  it("an unreadable subscription is a 503, never a free claim", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    mocks.entitled.mockRejectedValue(new Error("db down"));
    expect((await post(claimBody())).status).toBe(503);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("the email claim is not gated (the work email is not part of the paid number)", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    const res = await post({ channel: "email", idempotencyKey: KEY });
    expect(res.status).toBe(200);
    expect(mocks.entitled).not.toHaveBeenCalled();
  });

  it("candidates: flag on and not subscribed mints no claim token and searches nothing", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    const res = await candidates(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    const { status, data } = await parseJsonResponse<{ code: string }>(res);
    expect(status).toBe(403);
    expect(data.code).toBe("subscription_required");
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
  });

  it("candidates: flag off and flag on + subscribed both search", async () => {
    const off = await candidates(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    expect(off.status).toBe(200);
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    mocks.entitled.mockResolvedValue(true);
    const on = await candidates(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    expect(on.status).toBe(200);
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenCalledTimes(2);
  });
});

describe("auto-provision when the subscription becomes active (webhook)", () => {
  const sub = (extra: Row = {}): Row => ({ stripe_subscription_id: "sub_1", owner_user_id: "vendor-1", owner_role: "vendor", status: "active", ...extra });
  const provision = vi.fn();
  const fakeDb = (rows: Row[]) =>
    createFakeDb({ number_subscriptions: rows, vendor_business_profiles: [{ user_id: "vendor-1", service_area_zips: ["98101"] }] }) as unknown as SupabaseClient;

  beforeEach(() => {
    provision.mockReset();
    provision.mockResolvedValue({ status: "provisioned", phoneNumber: "+12065550177" });
  });

  it("flag off: does nothing", async () => {
    expect(await provisionVendorNumberOnActivation(fakeDb([sub()]), "sub_1", { provision })).toBe("skipped");
    expect(provision).not.toHaveBeenCalled();
  });

  it("flag on: provisions the owner FROM OUR ROW, seeded with the subscription id", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    expect(await provisionVendorNumberOnActivation(fakeDb([sub()]), { id: "sub_1" }, { provision })).toBe("provisioned");
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0]![1]).toBe("vendor-1");
    expect(provision.mock.calls[0]![2]).toMatchObject({ idempotencySeed: "sub_1" });
  });

  it("a replayed event finds the number already there and buys nothing more", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    provision.mockResolvedValueOnce({ status: "provisioned", phoneNumber: "+12065550177" });
    provision.mockResolvedValueOnce({ status: "already", phoneNumber: "+12065550177" });
    const d = fakeDb([sub()]);
    expect(await provisionVendorNumberOnActivation(d, "sub_1", { provision })).toBe("provisioned");
    expect(await provisionVendorNumberOnActivation(d, "sub_1", { provision })).toBe("already");
    // Both calls carry the same seed, so the claim key is identical: the database fence buys once.
    expect(provision.mock.calls[0]![2]).toEqual(provision.mock.calls[1]![2]);
  });

  it("only an ACTIVE VENDOR row provisions (resident, past_due, unknown subscription are skipped)", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    expect(await provisionVendorNumberOnActivation(fakeDb([sub({ owner_role: "resident" })]), "sub_1", { provision })).toBe("skipped");
    expect(await provisionVendorNumberOnActivation(fakeDb([sub({ status: "past_due" })]), "sub_1", { provision })).toBe("skipped");
    expect(await provisionVendorNumberOnActivation(fakeDb([sub()]), "sub_other", { provision })).toBe("skipped");
    expect(await provisionVendorNumberOnActivation(fakeDb([sub()]), null, { provision })).toBe("skipped");
    expect(provision).not.toHaveBeenCalled();
  });

  it("soft-fails: a provisioning error never throws into the webhook", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    provision.mockRejectedValue(new Error("twilio down"));
    expect(await provisionVendorNumberOnActivation(fakeDb([sub()]), "sub_1", { provision })).toBe("failed");
  });
});
