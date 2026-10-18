// STOP and START on the shared PropLane number, through the real webhook route. The route runs the carrier
// keywords BEFORE the router, so a STOP never reaches an agent or a team; it lands in the one global ledger
// that every line and every team reads. The database function is replaced by a port of
// apply_sms_control_keyword (supabase/migrations/20260825120000_sms_control_plane.sql); the same function was
// also exercised against the dev database in a rolled-back transaction (docs/agents/one-number.md).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "../../unit/support/memory-supabase";

const sim = vi.hoisted(() => ({
  db: null as any,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  receipts: [] as Array<{ sid: string; key: string; keyword: string; at: string }>,
  providerTime: new Map<string, string>(),
  seam: vi.fn(),
  demoEnded: [] as string[],
  run: vi.fn(),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "t",
  fetchTwilioMessageCreatedAt: vi.fn(async (sid: string) => sim.providerTime.get(sid) ?? new Date().toISOString()),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({ loadInboundReplay: async () => ({ ok: true, receipt: null }) }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({
  inboundMediaParams: () => ({}),
  inboundRuntime: () => "development",
  runClaimedInbound: sim.run,
  twimlOk: (body?: unknown) => new Response(`<Response>${typeof body === "string" ? body : ""}</Response>`, { status: 200 }),
}));
// The shared number belongs to no work-number owner: STOP on it is a global control, not a team's.
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: async () => null }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveWorkspaceOwnerForWorkNumber: async () => null }));
vi.mock("@/lib/vendor-work-identity-inbound.server", () => ({ ingestVendorWorkIdentitySms: async () => ({ handled: false }) }));
vi.mock("@/lib/resident-agent-number/inbound.server", () => ({ ingestResidentAgentNumberSms: async () => ({ handled: false }) }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ resolveVendorNumberSenderPhone: async () => null }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ inboundLogIdentityFields: () => ({}) }));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ handleSharedLineInbound: sim.seam }));
vi.mock("@/lib/one-number/demo/store.server", () => ({ endDemoForPhone: async (_db: unknown, key: string) => { sim.demoEnded.push(key); } }));
vi.mock("@/lib/one-number/shadow.server", () => ({ recordShadowDecision: async () => undefined }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => sim.db }));

import { POST } from "@/app/api/twilio/inbound/route";
import { readSmsSuppressionState } from "@/lib/sms-consent";

const SHARED = "+12065550100";
const KEY = "2065550142";
const FROM = "+12065550142";

/** apply_sms_control_keyword, global part: receipt by sid, STOP always suppresses, a delayed old START cannot reopen. */
function applyControl(args: Record<string, unknown>): { data: boolean; error: null } {
  const sid = String(args.p_message_sid);
  const key = String(args.p_recipient_phone_key);
  const keyword = String(args.p_keyword);
  const at = String(args.p_provider_occurred_at);
  if (sim.receipts.some((r) => r.sid === sid)) return { data: false, error: null };
  sim.receipts.push({ sid, key, keyword, at });
  const ledger = (sim.db.__tables.sms_consent as Array<Record<string, any>>);
  let row = ledger.find((r) => r.phone === key);
  if (keyword === "START" && sim.receipts.some((r) => r.key === key && r.keyword === "STOP" && Date.parse(r.at) >= Date.parse(at))) return { data: false, error: null };
  if (keyword === "STOP") {
    if (!row) ledger.push((row = { phone: key, opted_in_at: null, opted_out_at: at }));
    else row.opted_out_at = row.opted_out_at && Date.parse(row.opted_out_at) > Date.parse(at) ? row.opted_out_at : at;
  } else if (keyword === "START") {
    if (!row) ledger.push({ phone: key, opted_in_at: at, opted_out_at: null });
    else if (!row.opted_out_at || Date.parse(row.opted_out_at) < Date.parse(at)) row.opted_in_at = at;
  }
  return { data: true, error: null };
}

function freshDb() {
  const db = createMemoryDb({
    sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: SHARED, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [] }],
    sms_consent: [],
    profiles: [],
  });
  (db as any).rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    sim.rpcCalls.push({ fn, args });
    if (fn === "apply_sms_control_keyword") return applyControl(args);
    return { data: true, error: null };
  };
  return db;
}

let counter = 0;
function text(body: string, over: { from?: string; sid?: string } = {}) {
  const sid = over.sid ?? `SM${String(++counter).padStart(32, "0")}`;
  const form = new URLSearchParams({ From: over.from ?? FROM, To: SHARED, Body: body, MessageSid: sid });
  return POST(new Request("https://example.test/api/twilio/inbound", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig" } }));
}
const optedOut = async () => {
  const state = await readSmsSuppressionState(sim.db, FROM);
  return state.ok && state.optedOut;
};

beforeEach(() => {
  sim.db = freshDb();
  sim.rpcCalls.length = 0; sim.receipts.length = 0; sim.providerTime.clear(); sim.demoEnded.length = 0;
  sim.seam.mockReset().mockResolvedValue({ kind: "none" });
  sim.run.mockReset().mockResolvedValue(new Response("<Response/>", { status: 200 }));
});

describe("STOP on the shared number", () => {
  it("opts the phone out of every line at once, answers 200, and never reaches the router or an agent", async () => {
    expect(await optedOut()).toBe(false);
    const res = await text("STOP");
    expect(res.status).toBe(200);
    expect(sim.rpcCalls).toHaveLength(1);
    expect(sim.rpcCalls[0]!.args).toMatchObject({ p_keyword: "STOP", p_recipient_phone_key: KEY, p_manager_user_id: null, p_messaging_service_sid: null });
    expect(await optedOut()).toBe(true);
    expect(sim.seam).not.toHaveBeenCalled();
    expect(sim.run).not.toHaveBeenCalled();
  });

  it("every carrier stop word counts, in any case, and only as the whole text", async () => {
    for (const word of ["stop", "Stop", "STOPALL", "unsubscribe", "Cancel", "END", "quit"]) {
      sim.db = freshDb();
      sim.rpcCalls.length = 0; sim.receipts.length = 0;
      await text(word);
      expect(sim.rpcCalls[0]?.args.p_keyword, word).toBe("STOP");
      expect(await optedOut(), word).toBe(true);
    }
    sim.db = freshDb();
    sim.rpcCalls.length = 0;
    await text("please stop by tomorrow to fix the sink");
    await text("stop it");
    expect(sim.rpcCalls).toHaveLength(0);
    expect(sim.seam).toHaveBeenCalledTimes(2); // ordinary texts go on to the router
  });

  it("ends a sandbox demo on that phone", async () => {
    await text("STOP");
    expect(sim.demoEnded).toEqual([KEY]);
  });

  it("a Twilio retry of the same STOP is one receipt", async () => {
    await text("STOP", { sid: "SM" + "9".repeat(32) });
    await text("STOP", { sid: "SM" + "9".repeat(32) });
    expect(sim.receipts).toHaveLength(1);
    expect(await optedOut()).toBe(true);
  });

  it("is global: the same phone is suppressed for a resident team and a vendor team alike", async () => {
    await text("STOP");
    // Any team's send door reads the one ledger by phone.
    for (const phone of ["+12065550142", "(206) 555-0142", "12065550142"]) {
      const state = await readSmsSuppressionState(sim.db, phone);
      expect(state).toEqual({ ok: true, optedOut: true });
    }
    // Another person is untouched.
    expect(await readSmsSuppressionState(sim.db, "+12065550999")).toEqual({ ok: true, optedOut: false });
  });
});

describe("START", () => {
  it("brings a stopped phone back", async () => {
    await text("STOP");
    expect(await optedOut()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const res = await text("START");
    expect(res.status).toBe(200);
    expect(sim.rpcCalls.at(-1)!.args.p_keyword).toBe("START");
    expect(await optedOut()).toBe(false);
  });

  it("a delayed, older START cannot reopen consent after a newer STOP", async () => {
    sim.providerTime.set("SM" + "1".repeat(32), "2026-10-18T10:00:00.000Z"); // the START, sent first
    sim.providerTime.set("SM" + "2".repeat(32), "2026-10-18T10:05:00.000Z"); // the STOP, sent later
    await text("STOP", { sid: "SM" + "2".repeat(32) });
    // The old START webhook arrives late (this phone is opted out, so START is treated as a control).
    await text("START", { sid: "SM" + "1".repeat(32) });
    expect(await optedOut()).toBe(true);
  });

  it("YES from someone who is NOT opted out is an answer, not a START (it can confirm a proposal)", async () => {
    await text("YES");
    expect(sim.rpcCalls).toHaveLength(0);
    expect(sim.seam).toHaveBeenCalledTimes(1);
    expect(sim.seam.mock.calls[0]![1]).toMatchObject({ body: "YES", phoneKey: KEY });
  });

  it("YES from someone who IS opted out is a START", async () => {
    await text("STOP");
    await new Promise((r) => setTimeout(r, 5));
    await text("YES");
    expect(sim.rpcCalls.at(-1)!.args.p_keyword).toBe("START");
    expect(await optedOut()).toBe(false);
  });
});

describe("HELP", () => {
  it("is a control message that changes no consent and never reaches an agent", async () => {
    await text("HELP");
    expect(sim.rpcCalls[0]!.args.p_keyword).toBe("HELP");
    expect(await optedOut()).toBe(false);
    expect(sim.seam).not.toHaveBeenCalled();
  });
});
