// The Conversations webhook (signature or nothing), the leave-group seam, the manager announce tool.
import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, OWNER, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));

const handled = vi.hoisted(() => ({ message: vi.fn(async () => ({ handled: true, action: "silent" })), preference: vi.fn() }));
vi.mock("@/lib/house-groups/ra.server", () => ({
  handleGroupMessage: handled.message,
  handleGroupPreferenceText: handled.preference,
}));
const posts = vi.hoisted(() => ({ postToHouseGroup: vi.fn() }));
vi.mock("@/lib/house-groups/post.server", () => posts);
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: vi.fn(async () => ({ recorded: true })) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));

import { POST } from "@/app/api/twilio/conversations/route";
import { verifyConversationsWebhook } from "@/lib/house-groups/webhook.server";
import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { announceToHouseTool } from "@/lib/tools/domains/announce";
import { CO_MANAGER_SCOPED_TOOLS, COMMUNICATION_SENDING_TOOLS } from "@/lib/tools/manager-co-manager-tool-scope";

const URL_ = "https://app.example.test/api/twilio/conversations";
const TOKEN = "test-auth-token";
const SID = "CH" + "a".repeat(32);

function signed(params: Record<string, string>, opts: { token?: string; signature?: string | null } = {}) {
  const body = new URLSearchParams(params).toString();
  const signature = opts.signature === undefined ? twilio.getExpectedTwilioSignature(opts.token ?? TOKEN, URL_, params) : opts.signature;
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(signature ? { "x-twilio-signature": signature } : {}) },
    body,
  });
}
const event = (over: Record<string, string> = {}) => ({
  EventType: "onMessageAdded",
  ConversationSid: SID,
  MessageSid: "IM" + "b".repeat(32),
  Author: "+12065550101",
  Body: "PropLane, trash day?",
  ...over,
});

describe("Conversations webhook", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    vi.stubEnv("TWILIO_CONVERSATIONS_WEBHOOK_URL", URL_);
    handled.message.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a correctly signed onMessageAdded and reads the author, body and media", async () => {
    const parsed = await verifyConversationsWebhook(signed(event({ Media: JSON.stringify([{ Sid: "ME1" }, { Sid: "ME2" }]) })));
    expect(parsed).toMatchObject({ ok: true, message: { conversationSid: SID, author: "+12065550101", body: "PropLane, trash day?", mediaCount: 2 } });
  });

  it("refuses a bad signature before reading anything", async () => {
    const bad = await verifyConversationsWebhook(signed(event(), { signature: "not-a-signature" }));
    expect(bad).toMatchObject({ ok: false, status: 403 });
    const wrongToken = await verifyConversationsWebhook(signed(event(), { token: "someone-elses-token" }));
    expect(wrongToken).toMatchObject({ ok: false, status: 403 });
    const tampered = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilio.getExpectedTwilioSignature(TOKEN, URL_, event()) },
      body: new URLSearchParams(event({ Body: "something else" })).toString(),
    });
    expect(await verifyConversationsWebhook(tampered)).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed on Vercel when the signature is missing, and without an auth token", async () => {
    vi.stubEnv("VERCEL", "1");
    expect(await verifyConversationsWebhook(signed(event(), { signature: null }))).toMatchObject({ ok: false, status: 403 });
    vi.unstubAllEnvs();
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect(await verifyConversationsWebhook(signed(event()))).toMatchObject({ ok: false, status: 503 });
  });

  it("acknowledges other events and refuses a malformed one", async () => {
    expect(await verifyConversationsWebhook(signed(event({ EventType: "onConversationStateUpdated" })))).toEqual({ ok: false, status: 200, error: "ignored" });
    expect(await verifyConversationsWebhook(signed(event({ ConversationSid: "nope" })))).toMatchObject({ ok: false, status: 400 });
  });

  it("the route answers 403 to a forged call and never reaches the RA; a signed call is handled after the ack", async () => {
    const forged = await POST(signed(event(), { signature: "forged" }));
    expect(forged.status).toBe(403);
    expect(handled.message).not.toHaveBeenCalled();
    const ok = await POST(signed(event()));
    expect(ok.status).toBe(200);
    expect(handled.message).toHaveBeenCalledTimes(1);
    expect(handled.message).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationSid: SID, author: "+12065550101" }));
    const ignored = await POST(signed(event({ EventType: "onParticipantAdded" })));
    expect(ignored.status).toBe(200);
    expect(handled.message).toHaveBeenCalledTimes(1);
  });
});

describe("leave / join group in a 1:1 text", () => {
  const config = { mode: "shared" as const, sharedNumber: "+12065550100", messagingServiceSid: "MG1", pilotWorkspaceIds: [] };
  const input = (body: string) => ({ config, fromPhone: "+12065550101", body, messageSid: "SM1", mediaCount: 0, phoneKey: "2065550101" });

  it("answers 'leave group' in the seam when the sender belongs to a chat-enabled house", async () => {
    handled.preference.mockResolvedValueOnce({ handled: true, reply: "Done." });
    const result = await handleSharedLineInbound(fakeDb().db, input("Leave group"));
    expect(result).toEqual({ kind: "handled", twiml: "Done." });
    expect(handled.preference).toHaveBeenCalledWith(expect.anything(), { fromPhone: "+12065550101", command: "leave", messageSid: "SM1" });
  });

  it("does not look at an ordinary text", async () => {
    handled.preference.mockClear();
    await handleSharedLineInbound(fakeDb().db, input("hello there")).catch(() => undefined);
    expect(handled.preference).not.toHaveBeenCalled();
  });
});

describe("announce_to_house (the one manager announce tool)", () => {
  it("is a manager SMS tool behind the confirm gate and never reaches a delegated co-manager", () => {
    expect(announceToHouseTool.kind).toBe("write");
    expect(CO_MANAGER_SCOPED_TOOLS.has("announce_to_house")).toBe(false);
    expect(COMMUNICATION_SENDING_TOOLS.has("announce_to_house")).toBe(true);
    // The duplicate house-chat-only tool is gone: one tool posts to groups and falls back to one on one.
    expect(COMMUNICATION_SENDING_TOOLS.has("announce_to_house_chat")).toBe(false);
  });
});

void fakeGateway;
