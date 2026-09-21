import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileVendorWorkIdentity,
  type VendorWorkIdentityProvider,
} from "@/lib/vendor-work-identity.server";

const identity = {
  id: "identity-1", vendor_user_id: "vendor-1", lifecycle_state: "reconciling",
  email_state: "ready", sms_state: "reconciling", email_address: "vendor-1@example.test", email_provider_id: "domain-1",
  email_send_ready: true, email_receive_ready: true, phone_number: null, phone_number_sid: null, messaging_service_sid: null,
  carrier_ready: false, sms_send_ready: false, sms_receive_ready: false, attachment_state: "reconciling", quarantined_at: null, released_at: null,
};

/** Narrow fake for the reconciliation service; every write resolves successfully. */
function fakeDb() {
  const writes: unknown[] = [];
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.in = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.update = (value: unknown) => { writes.push({ table, value }); return q; };
    q.maybeSingle = async () => {
      if (table === "vendor_work_identities") return { data: identity, error: null };
      if (table === "vendor_work_identity_operations") return { data: { id: "operation-1", state: "reconciling", created_at: new Date(Date.now() - 16 * 60_000).toISOString() }, error: null };
      if (table === "vendor_work_identity_runtime") return { data: { enabled: true, max_active_identities: 10, outbound_message_cap: 100 }, error: null };
      return { data: null, error: null };
    };
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === "vendor_work_identity_usage_events" ? [] : null, error: null });
    return q;
  });
  return { db: { from } as unknown as SupabaseClient, writes };
}

function fakeProvider(): VendorWorkIdentityProvider {
  return {
    emailConfigured: () => false,
    smsConfigured: () => true,
    emailDomainReadiness: vi.fn(),
    findSmsByOperation: vi.fn().mockResolvedValue({ phoneNumber: "+12065550111", phoneSid: "PN1" }),
    purchaseSms: vi.fn(),
    attachSms: vi.fn(),
    inspectSms: vi.fn().mockResolvedValue({ phoneNumber: "+12065550111", attached: true, carrierReady: true }),
  };
}

describe("vendor work identity reconciliation", () => {
  beforeEach(() => vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1"));
  it("recovers a tagged ambiguous purchase without another purchase or attachment", async () => {
    const { db, writes } = fakeDb();
    const provider = fakeProvider();
    await reconcileVendorWorkIdentity(db, "vendor-1", provider);
    expect(provider.findSmsByOperation).toHaveBeenCalledWith("operation-1");
    expect(provider.purchaseSms).not.toHaveBeenCalled();
    expect(provider.inspectSms).toHaveBeenCalledWith({ phoneSid: "PN1", messagingServiceSid: expect.any(String) });
    expect(provider.attachSms).not.toHaveBeenCalled();
    expect(writes).toContainEqual(expect.objectContaining({ table: "vendor_work_identities" }));
    expect(writes).toContainEqual(expect.objectContaining({ table: "vendor_work_identity_operations", value: expect.objectContaining({ state: "succeeded", provider_reference: "PN1" }) }));
  });

  it("inspects before attaching and re-inspects before ready", async () => {
    const { db } = fakeDb();
    const provider = fakeProvider();
    (provider.inspectSms as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ phoneNumber: "+12065550111", attached: false, carrierReady: false })
      .mockResolvedValueOnce({ phoneNumber: "+12065550111", attached: true, carrierReady: true });
    await reconcileVendorWorkIdentity(db, "vendor-1", provider);
    expect(provider.attachSms).toHaveBeenCalledTimes(1);
    expect(provider.inspectSms).toHaveBeenCalledTimes(2);
    expect((provider.inspectSms as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (provider.attachSms as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it("does not treat an unavailable provider lookup as definitive absence", async () => {
    const { db, writes } = fakeDb();
    const provider = fakeProvider();
    (provider.findSmsByOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network timeout"));
    await expect(reconcileVendorWorkIdentity(db, "vendor-1", provider)).rejects.toThrow("network timeout");
    expect(writes).toEqual([]);
    expect(provider.purchaseSms).not.toHaveBeenCalled();
  });
});
