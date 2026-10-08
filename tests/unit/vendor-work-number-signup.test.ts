// Vendor work number at signup (Oct 8): finishing onboarding with a verified phone gives the vendor a
// number picked on the SERVER near that phone. Once, retry-safe, never from client input, soft-failing,
// and only through the same gated setup path the Settings claim uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getActiveVendorNumber: vi.fn(),
  loadVendorVerifiedPhone: vi.fn(),
  searchVendorWorkNumberCandidates: vi.fn(),
  setupVendorWorkIdentity: vi.fn(),
  createVendorWorkIdentityProvider: vi.fn(() => ({ tag: "provider" })),
}));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  getActiveVendorNumber: mocks.getActiveVendorNumber,
  loadVendorVerifiedPhone: mocks.loadVendorVerifiedPhone,
  searchVendorWorkNumberCandidates: mocks.searchVendorWorkNumberCandidates,
  setupVendorWorkIdentity: mocks.setupVendorWorkIdentity,
  createVendorWorkIdentityProvider: mocks.createVendorWorkIdentityProvider,
}));

import {
  areaCodeOfPhone,
  provisionVendorWorkNumberAtSignup,
  vendorSignupIdempotencyKey,
} from "@/lib/vendor-work-number-signup.server";

const db = { tag: "db" } as unknown as SupabaseClient;
const provider = { tag: "provider" } as never;
const ready = (value: string) => ({ sms: { state: "ready", value } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  mocks.getActiveVendorNumber.mockResolvedValue(null);
  mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: true, phone: "+12065550142" });
  mocks.searchVendorWorkNumberCandidates.mockResolvedValue(["+12065550177", "+12065550178", "+12065550179"]);
  mocks.setupVendorWorkIdentity.mockResolvedValue(ready("+12065550177"));
});

describe("the signup idempotency key", () => {
  it("is a deterministic v5 UUID per vendor, so a retried signup can never claim twice", () => {
    const key = vendorSignupIdempotencyKey("vendor-1");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(vendorSignupIdempotencyKey("vendor-1")).toBe(key);
    expect(vendorSignupIdempotencyKey("vendor-2")).not.toBe(key);
  });

  it("reads the area code only from a US/Canada E.164 number", () => {
    expect(areaCodeOfPhone("+12065550142")).toBe("206");
    expect(areaCodeOfPhone("+442071838750")).toBeNull();
    expect(areaCodeOfPhone(null)).toBeNull();
  });
});

describe("provisionVendorWorkNumberAtSignup", () => {
  it("picks a candidate near the verified phone's area code and claims it once with the signup key", async () => {
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider });
    expect(result).toEqual({ status: "provisioned", phoneNumber: "+12065550177" });
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenCalledWith("206", provider, undefined);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledWith(
      db, "vendor-1", vendorSignupIdempotencyKey("vendor-1"), "sms", provider, "+12065550177",
    );
  });

  it("a retry for a vendor who already has a number searches and buys nothing", async () => {
    mocks.getActiveVendorNumber.mockResolvedValue({ phoneNumber: "+12065550177" });
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider });
    expect(result).toEqual({ status: "already", phoneNumber: "+12065550177" });
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("does nothing without a verified phone", async () => {
    mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: false, phone: "+12065550142" });
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).toEqual({ status: "skipped", reason: "phone_unverified" });
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("falls back to the first service zip for a phone with no US area code", async () => {
    mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: true, phone: "+442071838750" });
    await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider, serviceAreaZips: ["bad", "98101", "98004"] });
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenCalledWith("", provider, "98101");
  });

  it("widens to the service zip when the phone's own area code has nothing free", async () => {
    mocks.searchVendorWorkNumberCandidates.mockResolvedValueOnce([]).mockResolvedValueOnce(["+14255550123"]);
    mocks.setupVendorWorkIdentity.mockResolvedValue(ready("+14255550123"));
    const result = await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider, serviceAreaZips: ["98004"] });
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenNthCalledWith(1, "206", provider, undefined);
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenNthCalledWith(2, "", provider, "98004");
    expect(result).toEqual({ status: "provisioned", phoneNumber: "+14255550123" });
  });

  it("buys nothing when no local candidate exists (gates off, or none free): the Settings picker takes over", async () => {
    mocks.searchVendorWorkNumberCandidates.mockResolvedValue([]);
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).toEqual({ status: "skipped", reason: "no_candidate" });
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("never claims a toll-free or foreign candidate", async () => {
    mocks.searchVendorWorkNumberCandidates.mockResolvedValue(["+18005550142", "+442071838750"]);
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).toEqual({ status: "skipped", reason: "no_candidate" });
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("reports not_ready when the gated setup did not allocate (runtime switch off, provisioning off, capacity)", async () => {
    mocks.setupVendorWorkIdentity.mockResolvedValue({ sms: { state: "not_started", value: null } });
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).toEqual({ status: "skipped", reason: "not_ready" });
  });

  it("soft-fails: a thrown error never escapes and never blocks signup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.setupVendorWorkIdentity.mockRejectedValue(new Error("twilio down"));
    await expect(provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).resolves.toEqual({ status: "failed" });
    mocks.searchVendorWorkNumberCandidates.mockRejectedValue(new Error("search down"));
    await expect(provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider })).resolves.toEqual({ status: "failed" });
  });

  it("takes no number from its caller: the only inputs are the vendor id and a service-zip hint", () => {
    expect(provisionVendorWorkNumberAtSignup.length).toBeLessThanOrEqual(3);
    // A number smuggled into deps is not a declared input and is never read.
    return provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider, phoneNumber: "+19995550100" } as never).then(() => {
      expect(mocks.setupVendorWorkIdentity.mock.calls[0]![5]).toBe("+12065550177");
    });
  });
});
