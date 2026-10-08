// PropLane Number, vendor side: an AI turn on the vendor's number is paid from the vendor's number credit,
// reserved BEFORE the model runs. No subscription or no credit = no model call and no reply (the text is
// already in the inbox). Flag off: nothing here runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  deliver: vi.fn(),
  verified: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  balance: vi.fn(),
  entitled: vi.fn(),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: mocks.thread, scopeForRole: () => "vendor" }));
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({ deliverVendorWorkIdentity: mocks.deliver }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ loadVendorVerifiedPhone: mocks.verified }));
vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: vi.fn() }));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentTurn: vi.fn() }));
vi.mock("@/lib/number-subscription/credit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/number-subscription/credit.server")>()),
  reserveNumberCredit: mocks.reserve,
  finishNumberCredit: mocks.finish,
  getNumberCreditBalance: mocks.balance,
}));
vi.mock("@/lib/number-subscription/subscription.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/number-subscription/subscription.server")>()),
  numberServiceEntitled: mocks.entitled,
}));

import { runVendorNumberAiReply, hashSenderPhone, type VendorNumberAiTurn } from "@/lib/agent/vendor-number-ai.server";

const NOW = new Date("2026-10-08T18:00:00Z");
const SENDER = "+12065550199";
const number = { identityId: "identity-1", vendorUserId: "vendor-1", phoneNumber: "+12065550177", sendReady: true, forwardToPhone: true };
const provider = { configured: () => true, email: vi.fn(), sms: vi.fn() };

function seed(): FakeDb {
  return createFakeDb({
    vendor_work_identity_runtime: [{ singleton: true, enabled: true, outbound_message_cap: 1000 }],
    vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", phone_number: "+12065550177", sms_state: "ready", sms_send_ready: true }],
    vendor_work_identity_usage_events: [],
    vendor_work_identity_outbox: [],
    sms_consent: [],
    profiles: [],
    vendor_business_profiles: [{ user_id: "vendor-1", business_name: "Apex Plumbing", trades: ["Plumbing"], service_area: "Seattle", ai_info: { hours: "Mon-Fri 8am-6pm", rates: "", how_to_book: "", emergency: "", extra: "" } }],
    portal_inbox_thread_records: [],
  });
}
const run = (db: FakeDb, turn: VendorNumberAiTurn, sid = "SM1") =>
  runVendorNumberAiReply(db as unknown as SupabaseClient, { number, from: SENDER, text: "hours?", messageSid: sid, now: NOW }, { provider, turn });
const KEY = `vendor-ai-turn:${hashSenderPhone(SENDER)}:SM1`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1");
  mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
  mocks.deliver.mockResolvedValue({ ok: true, sent: true, providerMessageId: "SM-out" });
  mocks.verified.mockResolvedValue({ verified: true, phone: "+12065550142" });
  mocks.entitled.mockResolvedValue(true);
  mocks.balance.mockResolvedValue({ includedCents: 300, purchasedCents: 0, totalCents: 300 });
  mocks.reserve.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  mocks.finish.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("vendor-number AI metering (flag on)", () => {
  it("reserves the AI turn BEFORE the model runs, keeps it once the reply is out", async () => {
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "Mon-Fri 8am-6pm." }));
    expect(await run(seed(), turn)).toBe("replied");
    expect(mocks.reserve).toHaveBeenCalledWith("vendor-1", "ai_agent_turn", 1, KEY, expect.objectContaining({ metadata: { surface: "vendor_number_ai" } }));
    expect((mocks.reserve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((turn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
    expect(mocks.finish).toHaveBeenCalledWith("vendor-1", KEY, expect.objectContaining({ release: false }));
  });

  it("an empty credit never calls the model and never replies", async () => {
    mocks.balance.mockResolvedValue({ includedCents: 0, purchasedCents: 0, totalCents: 0 });
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "x" }));
    expect(await run(seed(), turn)).toBe("send_blocked");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("credit that cannot cover a turn plus a full reply is not enough to start one", async () => {
    mocks.balance.mockResolvedValue({ includedCents: 20, purchasedCents: 0, totalCents: 20 });
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "x" }));
    expect(await run(seed(), turn)).toBe("send_blocked");
    expect(turn).not.toHaveBeenCalled();
  });

  it("a lapsed subscription pauses the AI: no model call, no reply", async () => {
    mocks.entitled.mockResolvedValue(false);
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "x" }));
    expect(await run(seed(), turn)).toBe("send_blocked");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("the reserve is the authority: a refusal there means no model call", async () => {
    mocks.reserve.mockResolvedValue({ allowed: false, reason: "allowance_exhausted" });
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "x" }));
    expect(await run(seed(), turn)).toBe("out_of_credit");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("an unreadable ledger is no model call", async () => {
    mocks.reserve.mockRejectedValue(new Error("rpc failed"));
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "x" }));
    expect(await run(seed(), turn)).toBe("unavailable");
    expect(turn).not.toHaveBeenCalled();
  });

  it("hands the turn back when the model fails", async () => {
    const turn: VendorNumberAiTurn = vi.fn(async () => {
      throw new Error("model down");
    });
    expect(await run(seed(), turn)).toBe("unavailable");
    expect(mocks.finish).toHaveBeenCalledWith("vendor-1", KEY, expect.objectContaining({ release: true }));
  });

  it("hands the turn back when the reply is refused before any send was attempted", async () => {
    mocks.deliver.mockResolvedValue({ ok: false, reason: "out_of_credit" });
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "Mon-Fri 8am-6pm." }));
    expect(await run(seed(), turn)).toBe("not_delivered");
    expect(mocks.finish).toHaveBeenCalledWith("vendor-1", KEY, expect.objectContaining({ release: true }));
  });

  it("keeps the turn when the model answered but the send was attempted and failed", async () => {
    mocks.deliver.mockResolvedValue({ ok: false, reason: "provider_rejected", authorized: true });
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "Mon-Fri 8am-6pm." }));
    expect(await run(seed(), turn)).toBe("not_delivered");
    expect(mocks.finish).toHaveBeenCalledWith("vendor-1", KEY, expect.objectContaining({ release: false }));
  });
});

describe("flag off", () => {
  it("the AI runs exactly as before with no credit or subscription calls", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const turn: VendorNumberAiTurn = vi.fn(async () => ({ reply: "Mon-Fri 8am-6pm." }));
    expect(await run(seed(), turn)).toBe("replied");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.entitled).not.toHaveBeenCalled();
  });
});
