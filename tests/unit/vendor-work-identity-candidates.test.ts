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

  type FakeIdentityRow = Record<string, unknown>;

  function fakeDb(options: { ensuredId?: string; identity?: Partial<FakeIdentityRow>; claimedSequence?: boolean[]; unverified?: boolean } = {}) {
    const ensuredId = options.ensuredId ?? "identity-1";
    let identityRow: FakeIdentityRow = {
      id: ensuredId, vendor_user_id: "vendor-1", lifecycle_state: "not_started",
      email_state: "not_started", sms_state: "not_started", email_address: null, email_provider_id: null,
      email_send_ready: false, email_receive_ready: false, phone_number: null, phone_number_sid: null,
      messaging_service_sid: null, carrier_ready: false, sms_send_ready: false, sms_receive_ready: false,
      attachment_state: "not_started", quarantined_at: null, released_at: null,
      ...options.identity,
    };
    const writes: unknown[] = [];
    const from = vi.fn((table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.in = () => q;
      q.gte = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.update = (value: Record<string, unknown>) => {
        writes.push({ table, value });
        if (table === "vendor_work_identities") identityRow = { ...identityRow, ...value };
        return q;
      };
      q.maybeSingle = async () => {
        if (table === "vendor_work_identities") return { data: identityRow, error: null };
        if (table === "vendor_work_identity_runtime") {
          return { data: { enabled: true, max_active_identities: 10, outbound_message_cap: 100 }, error: null };
        }
        if (table === "profiles") {
          return { data: { phone: options.unverified ? null : "(206) 555-0142", phone_verified_at: options.unverified ? null : "2026-10-01T00:00:00Z" }, error: null };
        }
        return { data: null, error: null };
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "vendor_work_identity_usage_events" ? [] : null, error: null });
      return q;
    });
    // Real DB: `on conflict (vendor_user_id, operation_kind, idempotency_key) do
    // nothing` — claimed:true only the FIRST time a given key is inserted.
    const claimSequence = [...(options.claimedSequence ?? [true])];
    const rpc = vi.fn((name: string) => {
      if (name === "ensure_vendor_work_identity") return Promise.resolve({ data: ensuredId, error: null });
      if (name === "claim_vendor_work_identity_operation") {
        const claimed = claimSequence.length > 1 ? claimSequence.shift()! : claimSequence[0]!;
        return Promise.resolve({ data: [{ operation_id: "op-1", claimed, state: claimed ? "claimed" : "succeeded" }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    return { db: { from, rpc } as unknown as SupabaseClient, writes, rpc, currentIdentity: () => identityRow };
  }

  it("never buys for a vendor whose phone is not verified - nothing is claimed either", async () => {
    const { db, rpc } = fakeDb({ unverified: true });
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "77777777-7777-7777-7777-777777777777", "sms", provider, "+12065550101");
    expect(provider.searchSmsCandidates).not.toHaveBeenCalled();
    expect(provider.purchaseSms).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("only ever buys a US local number, even for a verified vendor", async () => {
    const { db, rpc } = fakeDb();
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "88888888-8888-8888-8888-888888888888", "sms", provider, "+18005550101");
    expect(provider.purchaseSms).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

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

  it("never buys a second number when the vendor already has an active/ready sponsored number", async () => {
    const { db, rpc } = fakeDb({ identity: { sms_state: "ready", phone_number: "+12065550199", phone_number_sid: "PN-existing", messaging_service_sid: "MG1", carrier_ready: true, sms_send_ready: true, sms_receive_ready: true, attachment_state: "attached" } });
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "44444444-4444-4444-4444-444444444444", "sms", provider, "+12065550101");
    expect(provider.purchaseSms).not.toHaveBeenCalled();
    // Short-circuits before even touching the idempotent claim RPC — no
    // needless operation row for a vendor who cannot buy anything anyway.
    expect(rpc).not.toHaveBeenCalledWith("claim_vendor_work_identity_operation", expect.anything());
  });

  it("never buys a second number when a purchase is already mid-flight (provisioning/reconciling), even before it reaches ready", async () => {
    const { db } = fakeDb({ identity: { sms_state: "reconciling", phone_number: "+12065550199" } });
    const provider = fakeProvider();
    await setupVendorWorkIdentity(db, "vendor-1", "55555555-5555-5555-5555-555555555555", "sms", provider, "+12065550101");
    expect(provider.purchaseSms).not.toHaveBeenCalled();
  });

  it("reusing the same idempotency key can never end up buying a DIFFERENT number", async () => {
    const { db } = fakeDb({ claimedSequence: [true, false] });
    const provider = fakeProvider();
    const SAME_KEY = "66666666-6666-6666-6666-666666666666";
    await setupVendorWorkIdentity(db, "vendor-1", SAME_KEY, "sms", provider, "+12065550101");
    expect(provider.purchaseSms).toHaveBeenCalledTimes(1);
    expect(provider.purchaseSms).toHaveBeenCalledWith(expect.objectContaining({ phoneNumber: "+12065550101" }));
    // Same key, a different requested number the second time — real Twilio call must not fire again.
    await setupVendorWorkIdentity(db, "vendor-1", SAME_KEY, "sms", provider, "+12065550999");
    expect(provider.purchaseSms).toHaveBeenCalledTimes(1);
  });
});
