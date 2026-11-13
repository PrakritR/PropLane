import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRequest: vi.fn(() => true),
  accept: vi.fn(),
  processEnvelope: vi.fn(),
  sendText: vi.fn(),
  opsPhones: vi.fn(),
  serviceOwner: vi.fn(),
  sharedConfig: vi.fn(),
  owned: vi.fn(),
  holder: { db: {} as unknown },
}));

vi.mock("twilio", () => ({ default: { validateRequest: mocks.validateRequest } }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "auth-token" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.holder.db }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: vi.fn(async () => false) }));
vi.mock("@/lib/sms/inbound-envelope.server", () => ({
  smsEnvelopeRuntime: () => "development",
  acceptInboundEnvelope: mocks.accept,
  processInboundEnvelope: mocks.processEnvelope,
}));
vi.mock("@/lib/one-number/service-line.server", () => ({ readServiceOwnerOrThrow: mocks.serviceOwner }));
vi.mock("@/lib/one-number/config.server", async (original) => ({
  ...(await original<typeof import("@/lib/one-number/config.server")>()),
  loadSharedLineConfig: mocks.sharedConfig,
}));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: mocks.owned }));
vi.mock("@/lib/one-number/inbound-alert.server", () => ({ loadPlatformOpsPhones: mocks.opsPhones }));
vi.mock("@/lib/service/service-manager.server", () => ({ sendTextFromServiceOwner: mocks.sendText }));

import { POST } from "@/app/api/twilio/inbound/route";
import { processAcceptedInbound } from "@/lib/sms/process-accepted-inbound.server";
import { ingestNonPhoneSenderText } from "@/lib/sms/non-phone-sender.server";
import { buildNonPhoneAlertText, classifyNonPhoneSender, nonPhoneConversationKey } from "@/lib/sms/non-phone-sender";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LINE = "+12066781909";

/** A tiny inbound_sms_log: select-by-sid and insert, nothing else. */
function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    rows,
    from: (table: string) => {
      if (table !== "inbound_sms_log") throw new Error(`unexpected table ${table}`);
      const q = {
        select: () => q,
        eq: (_c: string, sid: string) => ({ limit: async () => ({ data: rows.filter((r) => r.message_sid === sid), error: null }) }),
        insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; },
      };
      return q;
    },
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  mocks.accept.mockResolvedValue({ kind: "accepted", id: "env-1" });
  mocks.serviceOwner.mockResolvedValue(OWNER);
  mocks.sharedConfig.mockResolvedValue({ mode: "per_workspace", sharedNumber: null });
  mocks.owned.mockResolvedValue({ managerId: OWNER, workspaceId: null, messagingServiceSid: "MG1" });
  mocks.opsPhones.mockResolvedValue(["+12065550194"]);
  mocks.sendText.mockResolvedValue({ ok: true });
});

describe("classifyNonPhoneSender", () => {
  it("accepts short codes and alphanumeric ids, never a phone number", () => {
    expect(classifyNonPhoneSender("78156")).toEqual({ kind: "short_code", sender: "78156" });
    expect(classifyNonPhoneSender("22395")).toEqual({ kind: "short_code", sender: "22395" });
    expect(classifyNonPhoneSender(" 123456 ")).toEqual({ kind: "short_code", sender: "123456" });
    expect(classifyNonPhoneSender("ROOMIES")).toEqual({ kind: "alphanumeric", sender: "ROOMIES" });
    expect(classifyNonPhoneSender("+12065552222")).toBeNull();
    expect(classifyNonPhoneSender("2065552222")).toBeNull();
    expect(classifyNonPhoneSender("")).toBeNull();
    expect(classifyNonPhoneSender("12")).toBeNull();
    expect(classifyNonPhoneSender("<script>")).toBeNull();
  });
  it("builds a conversation key per sender and an alert carrying the whole code", () => {
    expect(nonPhoneConversationKey(OWNER, "78156")).toBe(`${OWNER}:unknown:sender:78156`);
    expect(buildNonPhoneAlertText("78156", "Roomies: your code is 483920.")).toBe("PropLane text from 78156: Roomies: your code is 483920.");
  });
});

describe("the inbound webhook with From=78156", () => {
  function request(from: string) {
    return new Request("https://prop-lane.space/api/twilio/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "valid" },
      body: new URLSearchParams({ From: from, To: LINE, Body: "Your Roomies code is 483920", MessageSid: "SM" + "a".repeat(32), AccountSid: "ACtest" }),
    });
  }
  it("accepts the text under its sender id instead of answering 400", async () => {
    const res = await POST(request("78156"));
    expect(res.status).toBe(200);
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(mocks.accept.mock.calls[0][1]).toMatchObject({ wireFrom: "78156", wireTo: LINE });
  });
  it("still refuses a sender that is neither a phone nor a short code", async () => {
    expect((await POST(request("!!"))).status).toBe(400);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});

describe("ingestNonPhoneSenderText", () => {
  it("stores one admin-visible conversation titled by the sender, body in full, and alerts once", async () => {
    const db = fakeDb();
    const body = "Roomies: your verification code is 483920. Do not share it.";
    const out = await ingestNonPhoneSenderText(db as never, { from: { kind: "short_code", sender: "78156" }, toPhone: LINE, body, messageSid: "SMa" });
    expect(out).toMatchObject({ stored: true, alerted: 1 });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      manager_user_id: OWNER,
      from_phone: "78156",
      to_phone: LINE,
      body,
      message_sid: "SMa",
      counterparty_role: "unknown",
      conversation_key: `${OWNER}:unknown:sender:78156`,
    });
    // The only outbound text is the alert to the ADMIN phone, body included. Nothing goes to the sender.
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const sent = mocks.sendText.mock.calls[0][1];
    expect(sent.toPhone).toBe("+12065550194");
    expect(sent.text).toContain("78156");
    expect(sent.text).toContain("483920");
    expect(mocks.sendText.mock.calls.some((c) => String(c[1].toPhone).includes("78156"))).toBe(false);
  });
  it("is idempotent on the MessageSid: a replay stores nothing new", async () => {
    const db = fakeDb();
    const args = { from: { kind: "short_code" as const, sender: "22395" }, toPhone: LINE, body: "code 111222", messageSid: "SMb" };
    await ingestNonPhoneSenderText(db as never, args);
    const again = await ingestNonPhoneSenderText(db as never, args);
    expect(again.stored).toBe(false);
    expect(db.rows).toHaveLength(1);
  });
  it("ignores a text to a number that is not the PropLane line", async () => {
    mocks.owned.mockResolvedValue({ managerId: "someone-else", workspaceId: null, messagingServiceSid: "MG1" });
    const db = fakeDb();
    const out = await ingestNonPhoneSenderText(db as never, { from: { kind: "short_code", sender: "78156" }, toPhone: "+12065550000", body: "x1", messageSid: "SMc" });
    expect(out.reason).toBe("not_propline_line");
    expect(db.rows).toHaveLength(0);
    expect(mocks.sendText).not.toHaveBeenCalled();
  });
});

describe("processAcceptedInbound with From=78156", () => {
  it("stores and alerts but prepares no reply bubble (no agent, no auto-reply, no STOP/HELP handling)", async () => {
    const db = fakeDb();
    mocks.holder.db = db;
    for (const body of ["Your code is 483920", "STOP", "HELP"]) {
      const out = await processAcceptedInbound({ From: "78156", To: LINE, Body: body, MessageSid: `SM-${body}` });
      expect(out.bubbles).toEqual([]);
      expect(out.sender).toBeUndefined();
    }
    expect(db.rows.map((r) => r.body)).toEqual(["Your code is 483920", "STOP", "HELP"]);
    expect(db.rows.every((r) => r.from_phone === "78156")).toBe(true);
  });
});
