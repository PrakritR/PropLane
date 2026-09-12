import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCompletion } from "@/lib/agent/provider";

const mocks = vi.hoisted(() => ({
  completions: [] as Array<ProviderCompletion | Promise<ProviderCompletion>>,
  provider: vi.fn(),
  primaryTrace: vi.fn(),
  shadowTrace: vi.fn(),
  sendWorkNumber: vi.fn(),
  createTourInquiry: vi.fn(),
  openTours: vi.fn(),
  publicListings: vi.fn(),
}));

vi.mock("@/lib/agent/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/provider")>();
  return {
    ...actual,
    completeAgentModel: mocks.provider.mockImplementation(async () => {
      const next = mocks.completions.shift();
      if (!next) throw new Error("missing deterministic primary completion");
      return Promise.resolve(next);
    }),
  };
});

vi.mock("@/lib/agent/leasing-sms-custom-instructions", () => ({
  leasingSmsSystemPromptForWorkNumberOwner: vi.fn(async () => "fixture leasing prompt"),
}));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (actor: unknown, _messages: unknown, run: () => Promise<unknown>, opts?: { onTraceId?: (id: string) => void }) => {
    mocks.primaryTrace(actor); opts?.onTraceId?.("trace-jain"); return run();
  },
  traceProspectShadowComparison: mocks.shadowTrace,
}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));
vi.mock("@/lib/tour-availability.server", () => ({ listOpenTourSlots: mocks.openTours }));
vi.mock("@/lib/tour-inquiry-create.server", () => ({ createTourInquiry: mocks.createTourInquiry }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.sendWorkNumber }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true, duplicate: false, state: "reserved" })),
}));
vi.mock("@/lib/comms-billing/turn-result.server", () => ({
  INTERRUPTED_COMMS_REPLY: "interrupted",
  readCommsTurnResult: vi.fn(),
  completeCommsTurn: vi.fn(async (_db: unknown, _owner: string, _key: string, result: unknown) => result),
}));

import { deliverLeasingSmsReply, runLeasingSmsAgentTurn } from "@/lib/agent/leasing-sms-agent.server";
import { runProspectGptShadow } from "@/lib/agent/prospect-gpt-shadow";
import { compareProspectShadow, projectProspectShadowPrimaryEvidence } from "@/lib/agent/prospect-shadow-comparison";

const JAIN = {
  id: "property-jain-home",
  title: "Jain Home",
  buildingName: "Jain Home",
  address: "12 Cedar Street",
  rentLabel: "$1,200",
  available: "Now",
  managerUserId: "manager-jain",
};

function completion(content: ProviderCompletion["content"], stopReason: ProviderCompletion["stopReason"]): ProviderCompletion {
  return {
    content,
    stopReason,
    usage: { inputTokens: 3, outputTokens: 2 },
    provider: "anthropic",
    latencyMs: 1,
  };
}

function text(value: string) {
  return completion([{ type: "text", text: value } as never], "end_turn");
}

function tool(name: string, input: object, id = `call-${name}`) {
  return completion([{ type: "tool_use", id, name, input } as never], "tool_use");
}

type Recent = { id: string; body: string; updated_at: string };

/** Minimal persistence double. It preserves the runtime's real queries while
 * keeping the test outside Supabase and every external transport. */
function dbFixture(args: { recent?: Recent[]; history?: Array<{ direction: string; body: string; message_sid?: string; created_at: string }>; rpc?: (name: string, input: Record<string, unknown>) => boolean }) {
  const session = { id: "session-jain", landlord_id: "manager-jain", kind: "leasing_sms", vendor_phone_e164: "+15550001111", status: "active" };
  const terminal = (value: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const name of ["eq", "in", "gte", "lt", "order", "limit"]) chain[name] = () => chain;
    chain.then = (resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
    chain.maybeSingle = async () => value;
    return chain;
  };
  const db = {
    from: vi.fn((table: string) => {
      if (table === "agent_sessions") {
        return {
          select: () => terminal({ data: session, error: null }),
          update: () => terminal({ data: null, error: null }),
          insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: session, error: null }) }) }),
        };
      }
      if (table === "agent_messages") {
        return {
          select: () => terminal({ data: [], count: 0, error: null }),
          insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "inbound-jain" }, error: null }) }) }),
        };
      }
      if (table === "manager_sms_messages") {
        return { select: () => terminal({ data: args.history?.filter((row) => row.direction === "inbound") ?? [], error: null }) };
      }
      if (table === "sms_outbox") {
        return { select: (columns: string) => terminal({
          data: columns.startsWith("id,") ? (args.recent ?? []) : (args.history?.filter((row) => row.direction === "outbound") ?? []),
          error: null,
        }) };
      }
      if (table === "prospect_sms_bursts") return { select: () => terminal({ data: { history_snapshot: [] }, error: null }) };
      // Cross-catalog resolution checks the work-number owner's rows first,
      // then falls back to the mocked public catalog fixture.
      if (table === "manager_property_records") return { select: () => terminal({ data: null, error: null }) };
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: vi.fn(async (name: string, input: Record<string, unknown>) => ({ data: args.rpc?.(name, input) ?? true, error: null })),
  };
  return db as never;
}

function burst(revision = 4) {
  return { burstId: "burst-jain", revision, workerId: "worker-jain", claimedSourceIds: ["jain-1", "jain-2"], snapshotCutoff: "2026-09-12T12:00:10.000Z" };
}

beforeEach(() => {
  mocks.completions.length = 0;
  mocks.provider.mockClear(); mocks.primaryTrace.mockReset(); mocks.shadowTrace.mockReset(); mocks.sendWorkNumber.mockReset(); mocks.createTourInquiry.mockReset(); mocks.openTours.mockReset(); mocks.publicListings.mockReset();
  mocks.publicListings.mockResolvedValue([JAIN]);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("AXIS_RELEASE_SHA", "runtime-fixture");
});

afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("prospect SMS runtime incident boundary", () => {
  it("keeps successful listing facts property-bound and leaves absent or unsupported evidence unproven", () => {
    const evidence = projectProspectShadowPrimaryEvidence([
      { name: "get_listing_details", arguments: { propertyId: "jain" }, output: { found: true, listing: { propertyId: "jain", title: "Jain Home", rentLabel: "$1,200" } } },
      { name: "get_listing_details", arguments: { propertyId: "other" }, output: { found: true, listing: { propertyId: "other", title: "Other Home", available: "Tomorrow" } } },
      { name: "get_listing_details", arguments: { propertyId: "missing" }, output: { found: false } },
    ]);
    expect(evidence.supportedFactGroups).toEqual([
      ["Jain Home", "Jain Home rent is $1,200"],
      ["Other Home", "Other Home is available Tomorrow"],
    ]);
    const identity = { burstId: "b", burstRevision: 1, shadowProvider: "openai" as const, shadowModel: "fixture" };
    expect(compareProspectShadow({ identity, primary: { evidence }, shadow: { output: "Jain Home is available Tomorrow." } }).grounding).toBe("unknown");
    expect(compareProspectShadow({ identity, primary: { evidence }, shadow: { output: "Jain Home rent is $9,999." } }).grounding).toBe("ungrounded");
    expect(compareProspectShadow({ identity, primary: {}, shadow: { output: "Jain Home is available." } }).grounding).toBe("unknown");
  });

  it("seals JainHome fragments into a serializable shadow snapshot with paired trace identity and canonical facts", async () => {
    mocks.completions.push(
      tool("get_listing_details", { propertyId: "property-jain-home" }),
      text("Jain Home is available Now."),
    );
    const turn = await runLeasingSmsAgentTurn(dbFixture({}), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111",
      inboundText: "Is JainHome available?\nActually Jain Home - can I tour it?", crossCatalog: true,
      inboundMessageSid: "jain-2", prospectBurst: burst(),
    });

    expect(turn).toMatchObject({ reply: "Jain Home is available Now.", suppressed: false, traceId: "trace-jain" });
    expect(mocks.primaryTrace).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ burstId: "burst-jain", burstRevision: 4 }) }));
    expect(turn?.shadowInput?.primaryEvidence).toMatchObject({
      supportedFacts: expect.arrayContaining(["Jain Home", "Jain Home is available Now"]),
      supportedFactGroups: [["Jain Home", "Jain Home is available Now", "Jain Home rent is $1,200", "Jain Home address is 12 Cedar Street"]],
    });
    const snapshot = JSON.parse(JSON.stringify(turn?.shadowInput));

    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "shadow-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "shadow-jain-tool", output: [{ type: "function_call", id: "item-jain", call_id: "call-jain", name: "get_listing_details", arguments: '{"propertyId":"property-jain-home"}' }], usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "shadow-jain", output: [{ type: "message", content: [{ type: "output_text", text: "Jain Home is available Now." }] }], usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const shadow = await runProspectGptShadow(snapshot);
    const firstInput = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).input);
    const replayInput = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).input);
    expect(firstInput).not.toContain("Jain Home is available Now.");
    expect(firstInput).not.toContain("$1,200");
    expect(replayInput).toContain("call-jain");
    expect(replayInput).toContain("$1,200");
    expect(shadow).toMatchObject({ status: "completed", comparison: {
      identity: expect.objectContaining({ burstId: "burst-jain", burstRevision: 4, promptId: "leasing-sms-agent", release: "runtime-fixture" }),
      grounding: "grounded",
    } });
  });

  it("fences a pending generation after a correction revision and carries the merged correction into the next real loop", async () => {
    let resolvePending!: (value: ProviderCompletion) => void;
    mocks.completions.push(
      new Promise<ProviderCompletion>((resolve) => { resolvePending = resolve; }),
      text("I could not submit that stale request. Please choose again."),
      text("Jain Home is available Now."),
    );
    let activeRevision = 4;
    const staleDb = dbFixture({ rpc: (name, input) => name !== "authorize_prospect_sms_inline_action" || input.p_revision === activeRevision });
    const pending = runLeasingSmsAgentTurn(staleDb, {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Tour JainHome", crossCatalog: true, prospectBurst: burst(4),
    });
    await vi.waitFor(() => expect(mocks.provider).toHaveBeenCalledTimes(1));
    // A second inbound correction advances the durable revision while Claude is
    // still pending. The old generation cannot claim its inline action.
    activeRevision = 5;
    resolvePending(tool("request_tour", { propertyId: "property-jain-home", slotKey: "2026-09-15T09:00", start: "2026-09-15T16:00:00.000Z", end: "2026-09-15T16:30:00.000Z", hostUserId: "manager-jain", name: "Jain", email: "jain@example.test", phone: "+15550001111" }));
    const stale = await pending;
    expect(stale?.reply).toContain("stale request");
    expect(staleDb.rpc).toHaveBeenCalledWith("authorize_prospect_sms_inline_action", expect.objectContaining({ p_revision: 4 }));
    // The request remains approval-first: the stale lease blocks the write
    // before request_tour can create an inquiry or book anything.
    expect(mocks.createTourInquiry).not.toHaveBeenCalled();
    // A resulting candidate cannot prepare an outbox.
    mocks.sendWorkNumber.mockResolvedValue({ ok: false, error: "prospect_burst_stale" });
    await expect(deliverLeasingSmsReply({ landlordId: "manager-jain", toPhone: "+15550001111", text: stale!.reply, prospectBurst: burst(4) })).resolves.toMatchObject({ ok: false, error: "prospect_burst_stale" });
    expect(mocks.sendWorkNumber).toHaveBeenCalledWith(expect.objectContaining({ prospectBurst: expect.objectContaining({ revision: 4 }) }));

    const corrected = await runLeasingSmsAgentTurn(dbFixture({}), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Tour JainHome\nActually Jain Home", crossCatalog: true, prospectBurst: burst(5),
    });
    expect(corrected?.reply).toBe("Jain Home is available Now.");
    expect(JSON.stringify(mocks.provider.mock.calls.at(-1)?.[0])).toContain("Tour JainHome\\nActually Jain Home");
  });

  it("keeps delivered acknowledgements silent but permits an explicit resend and a property correction", async () => {
    const recent = [{ id: "out-delivered", body: "Jain Home is available Now.", updated_at: new Date().toISOString() }];
    mocks.completions.push(
      tool("suppress_redundant_reply", { recentOutboundMessageId: "out-delivered", reason: "acknowledgment" }),
      text("Jain Home is available Now."),
      text("Jain Home is available Now."),
    );
    const silent = await runLeasingSmsAgentTurn(dbFixture({ recent }), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Thanks", crossCatalog: true, prospectBurst: burst(),
    });
    expect(silent).toMatchObject({ suppressed: true, reply: "", suppression: { referenceMessageId: "out-delivered" } });
    const resend = await runLeasingSmsAgentTurn(dbFixture({ recent }), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Please send that again", crossCatalog: true, prospectBurst: burst(5),
    });
    const correction = await runLeasingSmsAgentTurn(dbFixture({ recent }), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Actually, I meant Jain Home", crossCatalog: true, prospectBurst: burst(6),
    });
    expect(resend?.suppressed).toBe(false); expect(correction?.suppressed).toBe(false);
  });

  it("calls the typed tour availability tool with the canonical property, and distinguishes no slots from a lookup failure", async () => {
    mocks.openTours.mockResolvedValueOnce({ ok: true, slotHosts: {}, resolution: "resolved" });
    mocks.completions.push(tool("list_open_tour_slots", { propertyId: "property-jain-home" }), text("property-jain-home has no open tour slots."));
    const noSlots = await runLeasingSmsAgentTurn(dbFixture({}), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Can I tour Jain Home?", crossCatalog: true, prospectBurst: burst(),
    });
    expect(noSlots?.reply).toContain("no open tour slots");
    expect(mocks.openTours).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ propertyId: "property-jain-home" }));

    mocks.openTours.mockRejectedValueOnce(new Error("calendar unavailable"));
    mocks.completions.push(tool("list_open_tour_slots", { propertyId: "property-jain-home" }), text("I cannot check tour availability right now."));
    const failed = await runLeasingSmsAgentTurn(dbFixture({}), {
      landlordId: "manager-jain", prospectPhoneE164: "+15550001111", inboundText: "Can I tour Jain Home?", crossCatalog: true, prospectBurst: burst(5),
    });
    expect(failed?.reply).toContain("cannot check");
  });
});
