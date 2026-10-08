// The AI on a vendor's PropLane number (Oct 8): answer-only, bounded, traced, and never a manager's.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  deliver: vi.fn(),
  verified: vi.fn(),
  runAgentTurn: vi.fn(),
  traceAgentTurn: vi.fn(),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: mocks.thread, scopeForRole: () => "vendor" }));
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({ deliverVendorWorkIdentity: mocks.deliver }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ loadVendorVerifiedPhone: mocks.verified }));
vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("@/lib/observability/langfuse", () => ({ traceAgentTurn: mocks.traceAgentTurn }));

import {
  VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR,
  VENDOR_AI_TURNS_PER_VENDOR_PER_DAY,
  VENDOR_AI_TURN_METER,
  hashSenderPhone,
  runVendorNumberAiReply,
  type VendorNumberAiTurn,
} from "@/lib/agent/vendor-number-ai.server";
import { vendorNumberAiRegistry, VENDOR_NUMBER_AI_WRITE_TOOLS } from "@/lib/tools/vendor-number-ai-index";
import { buildVendorNumberAiContext } from "@/lib/tools/vendor-number-ai-context";
import { runReadTool, toAnthropicTools } from "@/lib/tools/registry";

const NOW = new Date("2026-10-08T18:00:00Z");
const SENDER = "+12065550199";
const number = { identityId: "identity-1", vendorUserId: "vendor-1", phoneNumber: "+12065550177", sendReady: true, forwardToPhone: true };
const provider = { configured: () => true, email: vi.fn(), sms: vi.fn() };
const AI_INFO = { hours: "Mon-Fri 8am-6pm", rates: "$95 service call", how_to_book: "Text the address", emergency: "Burst pipe: call (206) 555-0199", extra: "" };

function seed(aiInfo: Row | null = AI_INFO, outbox: Row[] = [], extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({
    vendor_work_identity_runtime: [{ singleton: true, enabled: true, outbound_message_cap: 1000 }],
    vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", phone_number: "+12065550177", sms_state: "ready", sms_send_ready: true }],
    vendor_work_identity_usage_events: [],
    sms_consent: [],
    profiles: [],
    ...extra,
    vendor_business_profiles: [{ user_id: "vendor-1", business_name: "Apex Plumbing", trades: ["Plumbing"], service_area: "Seattle", ai_info: aiInfo ?? {} }],
    vendor_work_identity_outbox: outbox,
    portal_inbox_thread_records: [],
  });
}
const outboxRow = (n: number, minutesAgo: number, extra: Row = {}): Row => ({
  vendor_user_id: "vendor-1", channel: "sms", recipient: SENDER, idempotency_key: `vendor-ai:SM-old-${n}`, status: "sent",
  created_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), ...extra,
});
const run = (db: FakeDb, turn: VendorNumberAiTurn | undefined, sid = "SM1", text = "what are your hours?") =>
  runVendorNumberAiReply(db as unknown as SupabaseClient, { number, from: SENDER, text, messageSid: sid, now: NOW }, { provider, turn });
const reply = (text: string): VendorNumberAiTurn => vi.fn(async () => ({ reply: text }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
  mocks.deliver.mockResolvedValue({ ok: true, sent: true, providerMessageId: "SM-out" });
  mocks.verified.mockResolvedValue({ verified: true, phone: "+12065550142" });
});

describe("the registry is answer-only", () => {
  it("holds exactly get_vendor_info (read) and handoff_to_vendor (the only write)", () => {
    const tools = [...vendorNumberAiRegistry.values()].map((t) => [t.name, t.kind]);
    expect(tools).toEqual([["get_vendor_info", "read"], ["handoff_to_vendor", "write"]]);
    expect(VENDOR_NUMBER_AI_WRITE_TOOLS).toEqual(["handoff_to_vendor"]);
  });

  it("offers the model both tools, and runs the write only through the explicit allowlist", async () => {
    const names = toAnthropicTools(vendorNumberAiRegistry, { readOnly: true, allowWrite: VENDOR_NUMBER_AI_WRITE_TOOLS }).map((t) => t.name);
    expect(names).toEqual(["get_vendor_info", "handoff_to_vendor"]);
    expect(toAnthropicTools(vendorNumberAiRegistry, { readOnly: true }).map((t) => t.name)).toEqual(["get_vendor_info"]);
    const ctx = buildVendorNumberAiContext(seed() as unknown as SupabaseClient, {
      vendorUserId: "vendor-1", senderPhone: SENDER, senderText: "x", messageSid: "SM1", forwardToPhone: true, provider,
    });
    const refused = await runReadTool(vendorNumberAiRegistry, ctx, "handoff_to_vendor", { reason: "x" });
    expect(refused.ok).toBe(false);
  });

  it("get_vendor_info reads only the owning vendor's notes", async () => {
    const db = seed();
    db.tables.vendor_business_profiles!.push({ user_id: "vendor-2", business_name: "Other", ai_info: { hours: "Other hours" } });
    const ctx = buildVendorNumberAiContext(db as unknown as SupabaseClient, {
      vendorUserId: "vendor-1", senderPhone: SENDER, senderText: "x", messageSid: "SM1", forwardToPhone: true, provider,
    });
    const result = await runReadTool(vendorNumberAiRegistry, ctx, "get_vendor_info", { vendorUserId: "vendor-2" });
    expect(result.ok).toBe(false);
    const own = await runReadTool(vendorNumberAiRegistry, ctx, "get_vendor_info", {});
    expect(own).toMatchObject({ ok: true, data: { businessName: "Apex Plumbing", hours: "Mon-Fri 8am-6pm", howToBook: "Text the address" } });
  });
});

describe("hand-off", () => {
  it("notes the vendor's inbox thread and texts the vendor's verified phone, once per inbound message", async () => {
    const db = seed();
    const ctx = buildVendorNumberAiContext(db as unknown as SupabaseClient, {
      vendorUserId: "vendor-1", senderPhone: SENDER, senderText: "pipe burst, come now", messageSid: "SM9", forwardToPhone: true, provider, now: NOW,
    });
    const result = await runReadTool(vendorNumberAiRegistry, ctx, "handoff_to_vendor", { reason: "Burst pipe, wants someone now" }, { allowWrite: VENDOR_NUMBER_AI_WRITE_TOOLS });
    expect(result).toMatchObject({ ok: true, data: { noted: true, forwarded: true } });
    expect(mocks.thread).toHaveBeenCalledWith(db, expect.objectContaining({
      ownerUserId: "vendor-1", conversation: { otherPartyPhone: SENDER }, messageId: "vendor-ai-handoff:SM9", automated: true, unread: true,
    }));
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const [, sent] = mocks.deliver.mock.calls[0]!;
    expect(sent).toMatchObject({ vendorUserId: "vendor-1", recipient: "+12065550142", idempotencyKey: "vendor-ai-handoff-fwd:SM9" });
    expect(sent.text).toContain("pipe burst, come now");
    // The sender is never texted by a hand-off.
    expect(mocks.deliver.mock.calls.every(([, call]) => call.recipient !== SENDER)).toBe(true);
  });

  it("only notes the inbox when the vendor turned forwarding off", async () => {
    const ctx = buildVendorNumberAiContext(seed() as unknown as SupabaseClient, {
      vendorUserId: "vendor-1", senderPhone: SENDER, senderText: "x", messageSid: "SM9", forwardToPhone: false, provider, now: NOW,
    });
    await runReadTool(vendorNumberAiRegistry, ctx, "handoff_to_vendor", { reason: "Wants a quote" }, { allowWrite: VENDOR_NUMBER_AI_WRITE_TOOLS });
    expect(mocks.thread).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});

describe("runVendorNumberAiReply", () => {
  it("answers from the vendor's number, marks the inbox copy Sent by AI, and introduces itself on the first reply", async () => {
    const db = seed();
    const turn = reply("We are open Monday to Friday, 8am to 6pm.");
    expect(await run(db, turn)).toBe("replied");
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const [, sent, usedProvider] = mocks.deliver.mock.calls[0]!;
    expect(sent).toMatchObject({ vendorUserId: "vendor-1", channel: "sms", recipient: SENDER, idempotencyKey: "vendor-ai:SM1" });
    expect(sent.text).toBe("AI assistant for Apex Plumbing: We are open Monday to Friday, 8am to 6pm.");
    expect(usedProvider).toBe(provider);
    expect(mocks.thread).toHaveBeenCalledWith(db, expect.objectContaining({
      ownerUserId: "vendor-1", outbound: true, sentByAi: true, messageId: "vendor-ai-sms:SM1", channel: "sms",
    }));
  });

  it("does not repeat the introduction on later replies", async () => {
    const db = seed(AI_INFO, [outboxRow(1, 10)]);
    await run(db, reply("Yes, $95 for the service call."), "SM2");
    expect(mocks.deliver.mock.calls[0]![1].text).toBe("Yes, $95 for the service call.");
  });

  it("does nothing when the vendor has written no AI info at all", async () => {
    const turn = reply("hi");
    expect(await run(seed({}), turn)).toBe("no_info");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("stops after 5 AI replies to one sender in an hour: no model call, no reply, the vendor is told", async () => {
    const used = Array.from({ length: VENDOR_AI_REPLIES_PER_SENDER_PER_HOUR }, (_, i) => outboxRow(i, 5 + i * 10));
    const turn = reply("hi");
    expect(await run(seed(AI_INFO, used), turn, "SM6")).toBe("rate_limited");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: "+12065550142", idempotencyKey: "vendor-ai-handoff-fwd:SM6" });
  });

  it("counts only this sender's attempts from the last hour", async () => {
    const outbox = [
      ...Array.from({ length: 5 }, (_, i) => outboxRow(i, 90 + i)), // older than an hour
      outboxRow(10, 5, { recipient: "+12065550111" }), // another sender
      outboxRow(12, 5, { idempotency_key: "vendor-route:SM-other" }), // not an AI reply
    ];
    expect(await run(seed(AI_INFO, outbox), reply("Sure."))).toBe("replied");
  });

  it("counts blocked and failed attempts toward the 5 an hour", async () => {
    const statuses = ["blocked", "failed", "blocked", "reconciling", "blocked"];
    const used = statuses.map((status, i) => outboxRow(i, 5 + i, { status }));
    const turn = reply("hi");
    expect(await run(seed(AI_INFO, used), turn, "SM6")).toBe("rate_limited");
    expect(turn).not.toHaveBeenCalled();
  });

  it("counts model turns that never produced an outbox row (empty or failed) toward the 5 an hour", async () => {
    const recorded = Array.from({ length: 5 }, (_, i) => ({
      identity_id: "identity-1", vendor_user_id: "vendor-1", meter: VENDOR_AI_TURN_METER,
      idempotency_key: `vendor-ai-turn:${hashSenderPhone(SENDER)}:SM-old-${i}`, created_at: new Date(NOW.getTime() - (5 + i) * 60_000).toISOString(),
    }));
    const turn = reply("hi");
    expect(await run(seed(AI_INFO, [], { vendor_work_identity_usage_events: recorded }), turn, "SM6")).toBe("rate_limited");
    expect(turn).not.toHaveBeenCalled();
  });

  it("records every model turn before the model runs, even when it produces nothing", async () => {
    const db = seed();
    const turn: VendorNumberAiTurn = vi.fn(async () => {
      expect(db.tables.vendor_work_identity_usage_events).toHaveLength(1);
      return { reply: "" };
    });
    expect(await run(db, turn)).toBe("empty_reply");
    expect(db.tables.vendor_work_identity_usage_events![0]).toMatchObject({ meter: VENDOR_AI_TURN_METER, vendor_user_id: "vendor-1" });
    expect(String(db.tables.vendor_work_identity_usage_events![0]!.idempotency_key)).not.toContain(SENDER);
  });

  it("stops at the per-vendor daily ceiling across many senders, with no model call", async () => {
    const turns = Array.from({ length: VENDOR_AI_TURNS_PER_VENDOR_PER_DAY }, (_, i) => ({
      identity_id: "identity-1", vendor_user_id: "vendor-1", meter: VENDOR_AI_TURN_METER,
      idempotency_key: `vendor-ai-turn:sender-${i}:SM-${i}`, created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
    }));
    const turn = reply("hi");
    expect(await run(seed(AI_INFO, [], { vendor_work_identity_usage_events: turns }), turn)).toBe("daily_limit");
    expect(turn).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    // Turns older than a day do not count.
    const old = turns.map((t) => ({ ...t, created_at: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() }));
    expect(await run(seed(AI_INFO, [], { vendor_work_identity_usage_events: old }), reply("ok"))).toBe("replied");
  });

  describe("the model is not called when the reply could not leave", () => {
    const skipped = async (db: FakeDb) => {
      const turn = reply("hi");
      expect(await run(db, turn)).toBe("send_blocked");
      expect(turn).not.toHaveBeenCalled();
      expect(mocks.deliver).not.toHaveBeenCalled();
      expect(db.tables.vendor_work_identity_usage_events!.filter((e) => e.meter === VENDOR_AI_TURN_METER)).toHaveLength(0);
    };

    it("monthly segment cap exhausted", async () => {
      const used = { identity_id: "identity-1", vendor_user_id: "vendor-1", meter: "outbound_sms", quantity: 1000, idempotency_key: "o1", created_at: NOW.toISOString() };
      await skipped(seed(AI_INFO, [], { vendor_work_identity_usage_events: [used] }));
    });

    it("sender opted out", async () => {
      await skipped(seed(AI_INFO, [], { sms_consent: [{ phone: "2065550199", opted_out_at: "2026-10-01T00:00:00Z" }] }));
    });

    it("number paused, not send-ready, or provider disabled", async () => {
      await skipped(seed(AI_INFO, [], { vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", sms_state: "disabled", sms_send_ready: false }] }));
      await skipped(seed(AI_INFO, [], { vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", sms_state: "ready", sms_send_ready: false }] }));
      await skipped(seed(AI_INFO, [], { vendor_work_identity_runtime: [{ singleton: true, enabled: false, outbound_message_cap: 1000 }] }));
    });
  });

  it("keeps the raw sender phone out of the trace session id and metadata", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    mocks.traceAgentTurn.mockImplementation(async (_actor, _messages, runTurn: (o?: unknown) => Promise<unknown>) => runTurn(undefined));
    mocks.runAgentTurn.mockResolvedValue({ reply: "We open at 8." });
    await run(seed(), undefined);
    const [actor] = mocks.traceAgentTurn.mock.calls[0]!;
    expect(actor.sessionId).toBe(`vendor-number-ai:vendor-1:${hashSenderPhone(SENDER)}`);
    expect(JSON.stringify(actor)).not.toContain("2065550199");
    expect(hashSenderPhone(SENDER)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("respects the monthly cap: a send the cap blocks is not an error and leaves no inbox copy", async () => {
    mocks.deliver.mockResolvedValue({ ok: false, reason: "cap_or_outbox_blocked" });
    expect(await run(seed(), reply("Sure."))).toBe("not_delivered");
    expect(mocks.thread).not.toHaveBeenCalled();
  });

  it("does nothing, quietly, when the model is unavailable", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await run(seed(), undefined)).toBe("unavailable");
    const failing: VendorNumberAiTurn = vi.fn(async () => { throw new Error("overloaded"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await run(seed(), failing)).toBe("unavailable");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty model reply", async () => {
    expect(await run(seed(), reply("   "))).toBe("empty_reply");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("runs the traced, read-only turn on its own registry, stamped with the vendor's user id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    mocks.traceAgentTurn.mockImplementation(async (_actor, _messages, runTurn: (o?: unknown) => Promise<unknown>) => runTurn(undefined));
    mocks.runAgentTurn.mockResolvedValue({ reply: "We open at 8." });
    expect(await run(seed(), undefined)).toBe("replied");
    expect(mocks.traceAgentTurn).toHaveBeenCalledTimes(1);
    const [actor, , , opts] = mocks.traceAgentTurn.mock.calls[0]!;
    expect(actor).toMatchObject({ userId: "vendor-1" });
    expect(opts).toMatchObject({ name: "vendor-number-ai-turn", promptMeta: { promptId: "vendor-number-ai" } });
    const turnArgs = mocks.runAgentTurn.mock.calls[0]![0];
    expect(turnArgs.registry).toBe(vendorNumberAiRegistry);
    expect(turnArgs.readOnly).toBe(true);
    expect(turnArgs.allowWriteTools).toEqual(["handoff_to_vendor"]);
    expect(turnArgs.ctx).toMatchObject({ kind: "vendor_number_ai", vendorUserId: "vendor-1", senderPhone: SENDER });
    expect(turnArgs.messages).toEqual([{ role: "user", content: "what are your hours?" }]);
  });
});
