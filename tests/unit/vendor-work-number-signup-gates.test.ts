// Signup provisioning runs through the REAL gated setup path: it changes no default and enables nothing.
// With the runtime switch off, or provisioning off outside a dry run, nothing is bought; with the
// gates open it buys exactly once, and a retried Finish buys nothing more.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type Row } from "../helpers/fake-table-db";
import { provisionVendorWorkNumberAtSignup } from "@/lib/vendor-work-number-signup.server";
import type { VendorWorkIdentityProvider } from "@/lib/vendor-work-identity.server";

function seed(runtimeEnabled: boolean) {
  const base = createFakeDb({
    vendor_work_identity_runtime: [{ singleton: true, enabled: runtimeEnabled, max_active_identities: 10, outbound_message_cap: 1000 }],
    vendor_work_identities: [],
    vendor_work_identity_operations: [],
    vendor_work_identity_usage_events: [],
    profiles: [{ id: "vendor-1", phone: "(206) 555-0142", phone_verified_at: "2026-10-01T00:00:00Z" }],
  });
  const operations = new Map<string, boolean>();
  const rpc = async (name: string, args: Row) => {
    if (name === "ensure_vendor_work_identity") {
      const existing = base.tables.vendor_work_identities!.find((r) => r.vendor_user_id === args.p_vendor_user_id);
      if (existing) return { data: existing.id, error: null };
      base.tables.vendor_work_identities!.push({
        id: "identity-1", vendor_user_id: args.p_vendor_user_id, lifecycle_state: "not_started", email_state: "not_started", sms_state: "not_started",
        attachment_state: "not_started", phone_number: null, sms_receive_ready: false, sms_send_ready: false,
      });
      return { data: "identity-1", error: null };
    }
    if (name === "claim_vendor_work_identity_operation") {
      const key = String(args.p_idempotency_key);
      const claimed = !operations.has(key);
      operations.set(key, true);
      return { data: [{ operation_id: "op-1", claimed, state: "claimed" }], error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  return { db: Object.assign(base, { rpc }) as unknown as SupabaseClient, tables: base.tables };
}

function provider(): VendorWorkIdentityProvider & { purchaseSms: ReturnType<typeof vi.fn>; searchSmsCandidates: ReturnType<typeof vi.fn> } {
  return {
    emailConfigured: () => false,
    smsConfigured: () => true,
    emailDomainReadiness: vi.fn(),
    findSmsByOperation: vi.fn().mockResolvedValue(null),
    searchSmsCandidates: vi.fn().mockResolvedValue([{ phoneNumber: "+12065550177" }]),
    purchaseSms: vi.fn().mockResolvedValue({ phoneNumber: "+12065550177", phoneSid: "PN1" }),
    attachSms: vi.fn().mockResolvedValue({ attached: true, carrierReady: true }),
    inspectSms: vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
  vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL", "https://example.test/api/twilio/inbound");
  vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL", "https://example.test/api/twilio/events");
});
afterEach(() => vi.unstubAllEnvs());

describe("signup provisioning respects every existing gate", () => {
  it("buys nothing while provisioning is off (the default) outside a dry run", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "");
    vi.stubEnv("VENDOR_WORK_NUMBER_DRY_RUN", "");
    const { db } = seed(true);
    const p = provider();
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider: p })).toEqual({ status: "skipped", reason: "no_candidate" });
    expect(p.searchSmsCandidates).not.toHaveBeenCalled();
    expect(p.purchaseSms).not.toHaveBeenCalled();
  });

  it("buys nothing while the vendor-number runtime switch is off", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const { db, tables } = seed(false);
    const p = provider();
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider: p })).toEqual({ status: "skipped", reason: "not_ready" });
    expect(p.purchaseSms).not.toHaveBeenCalled();
    expect(tables.vendor_work_identities).toHaveLength(0);
  });

  it("with the gates open it buys exactly once, and a retried Finish buys nothing more", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const { db, tables } = seed(true);
    const p = provider();
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider: p })).toEqual({ status: "provisioned", phoneNumber: "+12065550177" });
    expect(p.purchaseSms).toHaveBeenCalledTimes(1);
    expect(p.purchaseSms).toHaveBeenCalledWith(expect.objectContaining({ phoneNumber: "+12065550177" }));
    expect(tables.vendor_work_identities![0]).toMatchObject({ phone_number: "+12065550177", sms_state: "ready" });

    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider: p })).toEqual({ status: "already", phoneNumber: "+12065550177" });
    expect(p.purchaseSms).toHaveBeenCalledTimes(1);
    expect(p.searchSmsCandidates).toHaveBeenCalledTimes(1);
  });

  it("an unverified phone buys nothing even with every gate open", async () => {
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
    const { db, tables } = seed(true);
    tables.profiles![0]!.phone_verified_at = null;
    const p = provider();
    expect(await provisionVendorWorkNumberAtSignup(db, "vendor-1", { provider: p })).toEqual({ status: "skipped", reason: "phone_unverified" });
    expect(p.purchaseSms).not.toHaveBeenCalled();
  });
});
