// A subscribed resident's personal number: the row insert is the purchase claim, so it is bought at most once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ entitled: vi.fn(), verified: vi.fn() }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({ numberServiceEntitled: mocks.entitled }));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  createVendorWorkIdentityProvider: vi.fn(),
  loadVendorVerifiedPhone: mocks.verified,
}));
vi.mock("@/lib/vendor-work-number-signup.server", () => ({
  areaCodeOfPhone: (e164: string | null | undefined) => /^\+1([2-9]\d{2})\d{7}$/.exec(e164 ?? "")?.[1] ?? null,
}));
vi.mock("@/lib/vendor-work-number-dry-run.server", () => ({ isVendorNumberDryRun: () => false }));

import {
  findActiveResidentAgentNumberByPhone,
  getActiveResidentAgentNumber,
  provisionResidentAgentNumber,
} from "@/lib/resident-agent-number/number.server";

const OWNER = "res-1";

function provider(over: Partial<Record<string, unknown>> = {}) {
  return {
    emailConfigured: () => false,
    smsConfigured: () => true,
    emailDomainReadiness: vi.fn(),
    findSmsByOperation: vi.fn(async () => null),
    searchSmsCandidates: vi.fn(async () => [{ phoneNumber: "+12065550177" }, { phoneNumber: "+12065550178" }]),
    purchaseSms: vi.fn(async () => ({ phoneNumber: "+12065550177", phoneSid: "PN1" })),
    attachSms: vi.fn(async () => ({ attached: true, carrierReady: false })),
    inspectSms: vi.fn(async () => ({ phoneNumber: "+12065550177", attached: true, carrierReady: false })),
    ...over,
  };
}

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({
    resident_agent_numbers: [],
    vendor_work_identities: [],
    vendor_work_identity_runtime: [{ singleton: true, enabled: true }],
    ...extra,
  });
}
const run = (db: FakeDb, p: ReturnType<typeof provider>, requireFlag = false) =>
  provisionResidentAgentNumber(db as unknown as SupabaseClient, OWNER, { provider: p as never, requireFlag });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SMS_PROVISIONING_ENABLED", "1");
  vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_WEBHOOK_URL", "https://app.example/api/twilio/inbound");
  vi.stubEnv("VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL", "https://app.example/api/twilio/events");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
  mocks.entitled.mockResolvedValue(true);
  mocks.verified.mockResolvedValue({ verified: true, phone: "+12065550142" });
});

describe("provisionResidentAgentNumber", () => {
  it("buys one local number near the verified phone for a subscribed resident", async () => {
    const db = seed();
    const p = provider();
    expect(await run(db, p)).toEqual({ status: "ready", phoneNumber: "+12065550177" });
    expect(p.searchSmsCandidates).toHaveBeenCalledWith({ areaCode: "206", count: 5 });
    expect(p.purchaseSms).toHaveBeenCalledTimes(1);
    expect(db.tables.resident_agent_numbers![0]).toMatchObject({
      resident_user_id: OWNER,
      state: "ready",
      phone_number: "+12065550177",
      phone_number_sid: "PN1",
      sms_receive_ready: true,
      sms_send_ready: false,
      attachment_state: "attached",
    });
    expect(await getActiveResidentAgentNumber(db as unknown as SupabaseClient, OWNER)).toMatchObject({ phoneNumber: "+12065550177", sendReady: false });
    expect(await findActiveResidentAgentNumberByPhone(db as unknown as SupabaseClient, "(206) 555-0177")).toMatchObject({ residentUserId: OWNER });
  });

  it("is idempotent: a replayed webhook or a second click never buys again", async () => {
    const db = seed();
    const p = provider();
    await run(db, p);
    expect(await run(db, p)).toEqual({ status: "already", phoneNumber: "+12065550177" });
    expect(p.purchaseSms).toHaveBeenCalledTimes(1);
    expect(db.tables.resident_agent_numbers).toHaveLength(1);
  });

  it("a lost claim race observes and never buys", async () => {
    const db = seed();
    const from = db.from.bind(db);
    db.from = (table: string) => {
      const b = from(table) as Record<string, unknown>;
      if (table === "resident_agent_numbers") {
        b.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "dup" } }) }) });
      }
      return b as ReturnType<FakeDb["from"]>;
    };
    const p = provider();
    expect(await run(db, p)).toEqual({ status: "pending" });
    expect(p.purchaseSms).not.toHaveBeenCalled();
  });

  it("holds an ambiguous purchase in reconciling and never buys a second number", async () => {
    const db = seed();
    const p = provider({ attachSms: vi.fn(async () => { throw new Error("socket timeout"); }) });
    expect(await run(db, p)).toEqual({ status: "pending" });
    expect(db.tables.resident_agent_numbers![0]).toMatchObject({ state: "reconciling", phone_number_sid: "PN1" });
    // The retry READS the provider and finishes the attach; it does not purchase.
    const healthy = provider();
    expect(await run(db, healthy)).toEqual({ status: "ready", phoneNumber: "+12065550177" });
    expect(healthy.purchaseSms).not.toHaveBeenCalled();
    expect(db.tables.resident_agent_numbers![0]).toMatchObject({ state: "ready" });
  });

  it("refuses without an active subscription, a verified phone, or the provider switch", async () => {
    mocks.entitled.mockResolvedValue(false);
    expect(await run(seed(), provider())).toEqual({ status: "skipped", reason: "not_entitled" });
    mocks.entitled.mockResolvedValue(true);
    mocks.verified.mockResolvedValue({ verified: false, phone: null });
    expect(await run(seed(), provider())).toEqual({ status: "skipped", reason: "phone_unverified" });
    mocks.verified.mockResolvedValue({ verified: true, phone: "+12065550142" });
    const off = seed({ vendor_work_identity_runtime: [{ singleton: true, enabled: false }] });
    expect(await run(off, provider())).toEqual({ status: "skipped", reason: "provider_disabled" });
    vi.stubEnv("SMS_PROVISIONING_ENABLED", "");
    expect(await run(seed(), provider())).toEqual({ status: "skipped", reason: "provider_unconfigured" });
  });

  it("from Settings the feature flag gates it; from the Stripe webhook it does not", async () => {
    const p = provider();
    expect(await run(seed(), p, true)).toEqual({ status: "skipped", reason: "not_available" });
    expect(p.purchaseSms).not.toHaveBeenCalled();
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
    expect(await run(seed(), p, true)).toMatchObject({ status: "ready" });
  });

  it("skips a candidate a vendor or another resident already holds", async () => {
    const db = seed({ vendor_work_identities: [{ id: "v1", vendor_user_id: "vendor-1", phone_number: "+12065550177" }] });
    const p = provider();
    const result = await run(db, p);
    expect(p.purchaseSms).toHaveBeenCalledWith(expect.objectContaining({ phoneNumber: "+12065550178" }));
    expect(result.status).toBe("ready");
  });
});
