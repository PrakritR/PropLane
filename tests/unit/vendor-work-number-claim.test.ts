import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  createTwilioRestClient: vi.fn(() => {
    throw new Error("a dry run must never construct a Twilio client");
  }),
  suppression: vi.fn(),
}));
vi.mock("@/lib/twilio-client.server", () => ({ createTwilioRestClient: mocks.createTwilioRestClient }));
vi.mock("@/lib/sms-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-consent")>()),
  readSmsSuppressionState: mocks.suppression,
}));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));

import {
  createVendorWorkIdentityProvider,
  getVendorWorkIdentity,
  loadVendorVerifiedPhone,
  responseFor,
  searchVendorWorkNumberCandidates,
  setupVendorWorkIdentity,
} from "@/lib/vendor-work-identity.server";
import { deliverVendorWorkIdentity, type VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";
import {
  clearDryRunCapturedSms,
  createDryRunVendorDeliveryProvider,
  dryRunCapturedSms,
  dryRunCandidateNumbers,
  isVendorNumberDryRun,
} from "@/lib/vendor-work-number-dry-run.server";
import { vendorNumberMonthStart } from "@/lib/vendor-work-number";

const KEY = "11111111-1111-4111-8111-111111111111";

/** Stateful enough for the real setup transition: rpc creates the identity row, writes land on it. */
function setupDb(opts: { verified?: boolean; runtimeEnabled?: boolean } = {}): { db: SupabaseClient; fake: FakeDb; rpc: ReturnType<typeof vi.fn> } {
  const fake = createFakeDb({
    vendor_work_identity_runtime: [{ singleton: true, enabled: opts.runtimeEnabled ?? true, max_active_identities: 10, outbound_message_cap: 1000 }],
    profiles: [{ id: "vendor-1", phone: opts.verified === false ? null : "(206) 555-0142", phone_verified_at: opts.verified === false ? null : "2026-10-01T00:00:00Z" }],
    vendor_work_identities: [],
    vendor_work_identity_operations: [{ id: "op-1" }],
    vendor_work_identity_usage_events: [],
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === "ensure_vendor_work_identity") {
      if (!fake.tables.vendor_work_identities!.length) {
        fake.tables.vendor_work_identities!.push({
          id: "identity-1", vendor_user_id: "vendor-1", lifecycle_state: "not_started", email_state: "not_started", sms_state: "not_started",
          email_address: null, email_provider_id: null, email_send_ready: false, email_receive_ready: false, phone_number: null, phone_number_sid: null,
          messaging_service_sid: null, carrier_ready: false, sms_send_ready: false, sms_receive_ready: false, attachment_state: "not_started",
          quarantined_at: null, released_at: null, forward_to_phone: true,
        });
      }
      return { data: "identity-1", error: null };
    }
    if (name === "claim_vendor_work_identity_operation") return { data: [{ operation_id: "op-1", claimed: true, state: "claimed" }], error: null };
    return { data: null, error: null };
  });
  return { db: { from: (t: string) => fake.from(t), rpc } as unknown as SupabaseClient, fake, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
  clearDryRunCapturedSms();
  mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
});

describe("who may claim a vendor work number", () => {
  it("a vendor with a verified phone, and nothing else", async () => {
    const { db } = setupDb();
    expect(await loadVendorVerifiedPhone(db, "vendor-1")).toEqual({ verified: true, phone: "+12065550142" });
  });

  it("an unverified phone cannot claim: the provider is never asked, nothing is created", async () => {
    vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "1");
    const { db, rpc, fake } = setupDb({ verified: false });
    const identity = await setupVendorWorkIdentity(db, "vendor-1", KEY, "sms", createVendorWorkIdentityProvider(), "+14255550177");
    expect(rpc).not.toHaveBeenCalled();
    expect(fake.tables.vendor_work_identities).toHaveLength(0);
    expect(identity.sms.blockedReason).toBe("phone_unverified");
    expect(identity.sms.canSetup).toBe(false);
    expect(identity.eligibility).toEqual({ phoneVerified: false, verifiedPhoneLabel: null });
  });

  it("a verified phone with no number yet can set up and shows the masked phone it forwards to", async () => {
    const { db } = setupDb();
    const identity = await getVendorWorkIdentity(db, "vendor-1", { ...createDryRunProviderForTest() });
    expect(identity.eligibility).toEqual({ phoneVerified: true, verifiedPhoneLabel: "+1 (206) 555-0142" });
    expect(identity.sms.canSetup).toBe(true);
    expect(identity.forwardToPhone).toBe(true);
  });

  it("an already-ready number keeps working even if verification later lapses; only a claim is gated", () => {
    const row = {
      id: "i", vendor_user_id: "v", lifecycle_state: "ready", email_state: "not_started", sms_state: "ready", email_address: null, email_provider_id: null,
      email_send_ready: false, email_receive_ready: false, phone_number: "+14255550177", phone_number_sid: "PN1", messaging_service_sid: "MG1", carrier_ready: true,
      sms_send_ready: true, sms_receive_ready: true, attachment_state: "attached", quarantined_at: null, released_at: null,
    } as never;
    const out = responseFor({ identity: row, runtime: { enabled: true, max_active_identities: 5, outbound_message_cap: 1000 }, emailConfigured: false, smsConfigured: true, outboundUsed: 0, phoneVerified: false });
    expect(out.sms).toMatchObject({ sendReady: true, receiveReady: true, blockedReason: "none" });
  });
});

function createDryRunProviderForTest() {
  vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "1");
  return createVendorWorkIdentityProvider();
}

describe("dry run: claim a number with no provider call", () => {
  it("is on only for an explicit opt-in on a non-production box with real provisioning off", () => {
    expect(isVendorNumberDryRun({})).toBe(false);
    expect(isVendorNumberDryRun({ VENDOR_WORK_NUMBER_DRY_RUN: "1" })).toBe(true);
    expect(isVendorNumberDryRun({ VENDOR_WORK_NUMBER_DRY_RUN: "1", NODE_ENV: "production" })).toBe(false);
    expect(isVendorNumberDryRun({ VENDOR_WORK_NUMBER_DRY_RUN: "1", VERCEL: "1" })).toBe(false);
    expect(isVendorNumberDryRun({ VENDOR_WORK_NUMBER_DRY_RUN: "1", SMS_PROVISIONING_ENABLED: "1" })).toBe(false);
  });

  it("offers fictional 555-01xx lines and never touches Twilio", async () => {
    vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "1");
    const numbers = await searchVendorWorkNumberCandidates("425");
    expect(numbers).toEqual(["+14255550177", "+14255550178", "+14255550179"]);
    expect(dryRunCandidateNumbers("12", 3)).toEqual([]);
    expect(mocks.createTwilioRestClient).not.toHaveBeenCalled();
  });

  it("claims a number end to end: ready, receiving, sending, and no provider purchase", async () => {
    vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "1");
    const { db, fake } = setupDb();
    const identity = await setupVendorWorkIdentity(db, "vendor-1", KEY, "sms", undefined, "+14255550177");
    const row = fake.tables.vendor_work_identities![0]!;
    expect(row).toMatchObject({ phone_number: "+14255550177", sms_state: "ready", sms_send_ready: true, sms_receive_ready: true, attachment_state: "attached" });
    expect(String(row.phone_number_sid)).toMatch(/^PNdryrun/);
    expect(identity.sms).toMatchObject({ value: "+14255550177", sendReady: true, receiveReady: true });
    expect(identity.dryRun).toBe(true);
    expect(mocks.createTwilioRestClient).not.toHaveBeenCalled();
  });

  it("without the opt-in and with provisioning off, nothing is searched or bought", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "0");
    const provider = { ...createVendorWorkIdentityProvider(), smsConfigured: () => true, searchSmsCandidates: vi.fn(), purchaseSms: vi.fn() };
    expect(await searchVendorWorkNumberCandidates("425", provider)).toEqual([]);
    const { db, fake } = setupDb();
    await setupVendorWorkIdentity(db, "vendor-1", KEY, "sms", provider, "+14255550177");
    expect(provider.searchSmsCandidates).not.toHaveBeenCalled();
    expect(provider.purchaseSms).not.toHaveBeenCalled();
    expect(fake.tables.vendor_work_identities).toHaveLength(0);
  });

  it("captures dry-run texts in memory and sends nothing", async () => {
    const provider = createDryRunVendorDeliveryProvider();
    expect(provider.configured("sms")).toBe(true);
    expect(provider.configured("email")).toBe(false);
    const sent = await provider.sms({ from: "+14255550177", to: "+12065550142", text: "[Alder] hi", idempotencyKey: "k1" });
    expect(sent.id).toMatch(/^SMdryrun/);
    expect(dryRunCapturedSms()).toEqual([{ from: "+14255550177", to: "+12065550142", text: "[Alder] hi", id: sent.id }]);
  });
});

const NOW = new Date();
// The cap window is the PACIFIC calendar month, so these fixtures are anchored
// to the same boundary the server counts from, not to the UTC one.
const MONTH_START_MS = vendorNumberMonthStart(NOW).getTime();
const startOfThisMonth = new Date(MONTH_START_MS + 1_000).toISOString();
const lastMonth = new Date(MONTH_START_MS - 86_400_000).toISOString();

function usageDb(events: Row[], cap = 1000): SupabaseClient {
  const fake = createFakeDb({
    vendor_work_identity_runtime: [{ singleton: true, enabled: true, max_active_identities: 10, outbound_message_cap: cap }],
    profiles: [{ id: "vendor-1", phone: "(206) 555-0142", phone_verified_at: "2026-10-01T00:00:00Z" }],
    vendor_work_identities: [{
      id: "identity-1", vendor_user_id: "vendor-1", lifecycle_state: "ready", email_state: "not_started", sms_state: "ready", email_address: null, email_provider_id: null,
      email_send_ready: false, email_receive_ready: false, phone_number: "+14255550177", phone_number_sid: "PN1", messaging_service_sid: "MG1", carrier_ready: true,
      sms_send_ready: true, sms_receive_ready: true, attachment_state: "attached", quarantined_at: null, released_at: null, forward_to_phone: true,
    }],
    vendor_work_identity_usage_events: events,
  });
  return { from: (t: string) => fake.from(t) } as unknown as SupabaseClient;
}

describe("fair use: 1,000 segments a month, then paused with a notice", () => {
  const provider = { emailConfigured: () => false, smsConfigured: () => true } as never;

  it("counts this month's outbound segments only", async () => {
    const out = await getVendorWorkIdentity(usageDb([
      { identity_id: "identity-1", meter: "outbound_sms", quantity: 40, created_at: startOfThisMonth },
      { identity_id: "identity-1", meter: "outbound_sms", quantity: 2, created_at: startOfThisMonth },
      { identity_id: "identity-1", meter: "outbound_sms", quantity: 900, created_at: lastMonth },
      { identity_id: "identity-1", meter: "inbound_sms", quantity: 50, created_at: startOfThisMonth },
    ]), "vendor-1", provider);
    expect(out.usage).toMatchObject({ smsSegmentsUsed: 42, outboundCap: 1000, capState: "available" });
    expect(out.sms.sendReady).toBe(true);
  });

  it("at the cap sends are paused but receiving continues, and the vendor sees the exhausted state", async () => {
    const out = await getVendorWorkIdentity(usageDb([{ identity_id: "identity-1", meter: "outbound_sms", quantity: 1000, created_at: startOfThisMonth }]), "vendor-1", provider);
    expect(out.usage.capState).toBe("exhausted");
    expect(out.sms).toMatchObject({ sendReady: false, receiveReady: true });
  });

  it("an email never spends the text cap", async () => {
    const out = await getVendorWorkIdentity(usageDb([{ identity_id: "identity-1", meter: "outbound_email", quantity: 1000, created_at: startOfThisMonth }]), "vendor-1", provider);
    expect(out.usage.smsSegmentsUsed).toBe(0);
    expect(out.sms.sendReady).toBe(true);
  });
});

describe("delivery from the vendor's number", () => {
  function deliveryDb(rpcOutbound: Record<string, unknown>) {
    const fake = createFakeDb({
      vendor_work_identity_outbox: [],
      vendor_work_identity_runtime: [{ singleton: true, enabled: true }],
      vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", email_address: null, phone_number: "+14255550177", email_state: "not_started", sms_state: "ready", email_send_ready: false, sms_send_ready: true, email_domain_verified: false }],
      vendor_work_identity_operations: [{ id: "op-1" }],
      vendor_work_identity_delivery_attempts: [],
    });
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_vendor_work_identity_operation") return { data: [{ operation_id: "op-1", claimed: true }], error: null };
      return { data: [rpcOutbound], error: null };
    });
    return { from: (t: string) => fake.from(t), rpc } as unknown as SupabaseClient;
  }
  const provider = (): VendorDeliveryProvider & { sms: ReturnType<typeof vi.fn> } => ({ configured: () => true, email: vi.fn(), sms: vi.fn().mockResolvedValue({ id: "SM1" }) });
  const input = { vendorUserId: "vendor-1", channel: "sms" as const, recipient: "+12065550142", recipientUserId: "vendor-1", subject: "Text message", text: "[Alder] hi", idempotencyKey: "vendor-fwd:SM9", sendClass: "transactional" as const };

  it("a forward goes out from the vendor's PropLane number", async () => {
    const p = provider();
    const result = await deliverVendorWorkIdentity(deliveryDb({ outbox_id: "ob-1", claimed: true, blocked_reason: null }), input, p);
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(p.sms).toHaveBeenCalledWith(expect.objectContaining({ from: "+14255550177", to: "+12065550142", text: "[Alder] hi" }));
  });

  it("the cap blocks before the provider is called", async () => {
    const p = provider();
    const result = await deliverVendorWorkIdentity(deliveryDb({ outbox_id: null, claimed: false, blocked_reason: "platform_cap_reached" }), input, p);
    expect(result).toMatchObject({ ok: false, reason: "platform_cap_reached" });
    expect(p.sms).not.toHaveBeenCalled();
  });

  it("STOP is unchanged: an opted-out phone is never texted", async () => {
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: true });
    const p = provider();
    const result = await deliverVendorWorkIdentity(deliveryDb({ outbox_id: "ob-1", claimed: true, blocked_reason: null }), input, p);
    expect(result).toMatchObject({ ok: false, reason: "recipient_opted_out" });
    expect(p.sms).not.toHaveBeenCalled();
  });
});
