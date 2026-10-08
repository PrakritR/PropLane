// A $5 PropLane Number is never sold for a number the platform cannot provision: the runtime kill switch,
// the vendor cap, the SMS provider and real provisioning (or a non-production dry run) must all be on.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-work-identity.server", () => ({ createVendorWorkIdentityProvider: () => ({ smsConfigured: () => true }) }));

import { getNumberAvailability } from "@/lib/number-subscription/availability.server";

function dbWith(runtime: Record<string, unknown> | null, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: runtime, error }) }) }),
    }),
  } as unknown as SupabaseClient;
}
const configured = { smsConfigured: () => true };
const unconfigured = { smsConfigured: () => false };

afterEach(() => vi.unstubAllEnvs());

describe("getNumberAvailability", () => {
  it("runtime switch off (the production state today): unavailable for both roles", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const db = dbWith({ enabled: false, max_active_identities: 0 });
    expect(await getNumberAvailability(db, "vendor", { provider: configured })).toEqual({ available: false, reason: "provider_disabled" });
    expect(await getNumberAvailability(db, "resident", { provider: configured })).toEqual({ available: false, reason: "provider_disabled" });
  });

  it("no runtime row or an unreadable one is unavailable, never a free pass", async () => {
    expect(await getNumberAvailability(dbWith(null), "vendor", { provider: configured })).toMatchObject({ available: false });
    expect(await getNumberAvailability(dbWith(null, { message: "boom" }), "vendor", { provider: configured })).toEqual({ available: false, reason: "unreadable" });
  });

  it("enabled with a zero cap blocks a vendor (no identity can be created) but not a resident", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const db = dbWith({ enabled: true, max_active_identities: 0 });
    expect(await getNumberAvailability(db, "vendor", { provider: configured })).toEqual({ available: false, reason: "capacity" });
    expect(await getNumberAvailability(db, "resident", { provider: configured })).toEqual({ available: true });
  });

  it("enabled but the SMS provider is not configured: unavailable", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const db = dbWith({ enabled: true, max_active_identities: 10 });
    expect(await getNumberAvailability(db, "vendor", { provider: unconfigured })).toEqual({ available: false, reason: "provider_unconfigured" });
  });

  it("enabled, configured, but real provisioning is off (and no dry run): unavailable", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "0");
    vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "");
    const db = dbWith({ enabled: true, max_active_identities: 10 });
    expect(await getNumberAvailability(db, "vendor", { provider: configured })).toEqual({ available: false, reason: "provider_unconfigured" });
  });

  it("everything on: available", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const db = dbWith({ enabled: true, max_active_identities: 10 });
    expect(await getNumberAvailability(db, "vendor", { provider: configured })).toEqual({ available: true });
    expect(await getNumberAvailability(db, "resident", { provider: configured })).toEqual({ available: true });
  });
});
