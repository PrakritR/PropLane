// VD04: real-provider search + claim-a-specific-number extension to the
// vendor work identity lifecycle (area code -> pick one of 3 -> claim).
// Every test injects a fake VendorWorkIdentityProvider — never mocks the
// Twilio client and never purchases a number.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  searchVendorWorkNumberCandidates,
  setupVendorWorkIdentity,
  type VendorWorkIdentityProvider,
} from "@/lib/vendor-work-identity.server";

function fakeProvider(overrides: Partial<VendorWorkIdentityProvider> = {}): VendorWorkIdentityProvider {
  return {
    emailConfigured: () => false,
    smsConfigured: () => true,
    emailDomainReadiness: vi.fn(),
    findSmsByOperation: vi.fn().mockResolvedValue(null),
    searchSmsCandidates: vi.fn().mockResolvedValue([
      { phoneNumber: "+12065550101" },
      { phoneNumber: "+12065550102" },
      { phoneNumber: "+12065550103" },
    ]),
    purchaseSms: vi.fn().mockResolvedValue({ phoneNumber: "+12065550102", phoneSid: "PN2" }),
    attachSms: vi.fn().mockResolvedValue({ attached: true, carrierReady: true }),
    inspectSms: vi.fn(),
    ...overrides,
  };
}

describe("searchVendorWorkNumberCandidates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never calls the provider when SMS provisioning is disabled", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "0");
    const provider = fakeProvider();
    const result = await searchVendorWorkNumberCandidates("206", provider);
    expect(result).toEqual([]);
    expect(provider.searchSmsCandidates).not.toHaveBeenCalled();
  });

  it("never calls the provider when SMS is not configured", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const provider = fakeProvider({ smsConfigured: () => false });
    const result = await searchVendorWorkNumberCandidates("206", provider);
    expect(result).toEqual([]);
    expect(provider.searchSmsCandidates).not.toHaveBeenCalled();
  });

  it("returns up to 3 candidate numbers from the provider when enabled and configured", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const provider = fakeProvider();
    const result = await searchVendorWorkNumberCandidates("206", provider);
    expect(provider.searchSmsCandidates).toHaveBeenCalledWith({ areaCode: "206", count: 3 });
    expect(result).toEqual(["+12065550101", "+12065550102", "+12065550103"]);
  });
});

describe("setupVendorWorkIdentity — claiming a specific picked number", () => {
  beforeEach(() => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
    vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL", "https://example.test/sms");
    vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL", "https://example.test/status");
  });
  afterEach(() => vi.unstubAllEnvs());

  function fakeDb(ensuredId = "identity-1") {
    const writes: unknown[] = [];
    const from = vi.fn((table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.in = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.update = (value: unknown) => {
        writes.push({ table, value });
        return q;
      };
      q.maybeSingle = async () => {
        if (table === "vendor_work_identities") {
          return {
            data: {
              id: ensuredId, vendor_user_id: "vendor-1", lifecycle_state: "not_started",
              email_state: "not_started", sms_state: "not_started", email_address: null, email_provider_id: null,
              email_send_ready: false, email_receive_ready: false, phone_number: null, phone_number_sid: null,
              messaging_service_sid: null, carrier_ready: false, sms_send_ready: false, sms_receive_ready: false,
              attachment_state: "not_started", quarantined_at: null, released_at: null,
            },
            error: null,
          };
        }
        if (table === "vendor_work_identity_runtime") {
          return { data: { enabled: true, max_active_identities: 10, outbound_message_cap: 100 }, error: null };
        }
        return { data: null, error: null };
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "vendor_work_identity_usage_events" ? [] : null, error: null });
      return q;
    });
    const rpc = vi.fn((name: string) => {
      if (name === "ensure_vendor_work_identity") return Promise.resolve({ data: ensuredId, error: null });
      if (name === "claim_vendor_work_identity_operation") {
        return Promise.resolve({ data: [{ operation_id: "op-1", claimed: true, state: "claimed" }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    return { db: { from, rpc } as unknown as SupabaseClient, writes };
  }

  it("purchases the vendor's exact picked number, not just the first available one", async () => {
    const { db } = fakeDb();
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "11111111-1111-1111-1111-111111111111", "sms", provider, "+12065550102");
    expect(provider.purchaseSms).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: "+12065550102" }),
    );
  });

  it("falls back to the provider's default single-candidate purchase when no number was picked", async () => {
    const { db } = fakeDb();
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "22222222-2222-2222-2222-222222222222", "sms", provider);
    expect(provider.purchaseSms).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: undefined }),
    );
  });
});
