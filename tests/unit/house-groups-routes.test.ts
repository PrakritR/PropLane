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
import { announceToHouseChatTool } from "@/lib/tools/domains/house-groups";
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

describe("announce_to_house_chat", () => {
  const groupFor = (id: string, property: string, ws = WS) => ({ id, workspace_id: ws, property_id: property, conversation_sid: `CH${id}`, status: "active", member_hash: id });
  const world = (extra: Record<string, never[] | Record<string, unknown>[]> = {}) =>
    fakeDb({
      manager_property_records: [
        { id: HOUSE, workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "5259 Brooklyn" } },
        { id: "prop-2", workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "5257 Brooklyn" } },
        { id: "prop-x", workspace_id: "ws-2", manager_user_id: "owner-2", row_data: { buildingName: "Elsewhere" } },
      ],
      house_group_conversations: [groupFor("g1", HOUSE), groupFor("g2", "prop-2"), groupFor("gx", "prop-x", "ws-2")],
      house_group_members: [{ id: "m", group_id: "g1", phone_key: "2065550101", phone_e164: "+12065550101", left_at: null }],
      ...extra,
    } as never);
  const ctx = (db: unknown) =>
    ({
      db,
      landlordId: OWNER,
      userId: OWNER,
      workspace: { id: WS, name: "Seattle Homes", isDefault: true, narrowing: false, propertyIds: [HOUSE, "prop-2"] },
    }) as never;

  beforeEach(() => {
    posts.postToHouseGroup.mockReset().mockResolvedValue({ ok: true, messageSid: "IM1" });
  });

  it("asks which house when several are on chat and none was named", async () => {
    const w = world();
    await expect(announceToHouseChatTool.preview(ctx(w.db), { message: "Water off Tuesday 9-12" })).rejects.toThrow(
      "Which house: 5257 Brooklyn, or 5259 Brooklyn? Or say all.",
    );
    expect(posts.postToHouseGroup).not.toHaveBeenCalled();
  });

  it("posts to the chosen house only, through the YES-gated handler", async () => {
    const w = world();
    const preview = await announceToHouseChatTool.preview(ctx(w.db), { message: "Water off Tuesday 9-12", propertyIds: [HOUSE] });
    expect(preview).toMatchObject({ kind: "announce_to_house_chat", fields: [{ label: "House chat", value: "5259 Brooklyn (1)" }, { label: "Message", value: "Water off Tuesday 9-12" }] });
    const result = await announceToHouseChatTool.handler(ctx(w.db), { message: "Water off Tuesday 9-12", propertyIds: [HOUSE] });
    expect(posts.postToHouseGroup).toHaveBeenCalledTimes(1);
    expect(posts.postToHouseGroup).toHaveBeenCalledWith(
      w.db,
      expect.objectContaining({ workspaceId: WS, propertyId: HOUSE, kind: "announcement", text: "Water off Tuesday 9-12" }),
      expect.anything(),
    );
    expect(result).toEqual({ reply: "Posted to 5259 Brooklyn." });
  });

  it("'all' posts to every house of this workspace, never another workspace's", async () => {
    const w = world();
    await announceToHouseChatTool.handler(ctx(w.db), { message: "Cleaning day Saturday", allHouses: true });
    const houses = posts.postToHouseGroup.mock.calls.map((c) => (c[1] as { propertyId: string }).propertyId).sort();
    expect(houses).toEqual([HOUSE, "prop-2"]);
  });

  it("refuses a house outside the workspace and reports a house held back", async () => {
    const w = world();
    await expect(announceToHouseChatTool.preview(ctx(w.db), { message: "Hi", propertyIds: ["prop-x"] })).rejects.toThrow("None of those houses");
    posts.postToHouseGroup.mockResolvedValueOnce({ ok: false, reason: "quiet_hours" });
    const result = (await announceToHouseChatTool.handler(ctx(w.db), { message: "Hi", propertyIds: [HOUSE] })) as { reply: string };
    expect(result.reply).toContain("between 10 pm and 8 am");
  });

  it("says so when no house has a chat, and is off while the switch is off", async () => {
    const empty = fakeDb();
    await expect(announceToHouseChatTool.preview(ctx(empty.db), { message: "Hi", allHouses: true })).rejects.toThrow("No house has a group chat yet");
    const off = world({ house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] });
    await expect(announceToHouseChatTool.preview(ctx(off.db), { message: "Hi", allHouses: true })).rejects.toThrow("No house has a group chat yet");
  });

  it("is a manager SMS tool behind the confirm gate and never reaches a delegated co-manager", () => {
    expect(announceToHouseChatTool.kind).toBe("write");
    // Not on the delegated allow-list (a co-manager cannot post to residents' chat), and gated as a Communication send.
    expect(CO_MANAGER_SCOPED_TOOLS.has("announce_to_house_chat")).toBe(false);
    expect(COMMUNICATION_SENDING_TOOLS.has("announce_to_house_chat")).toBe(true);
  });
});

void fakeGateway;
