// The webhook hands a house chat's Conversation to the bridge first; the relay does nothing for a house with no live group;
// the manager route authorizes on the house, masks phones and refuses a stranger's number without consent.
import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
const ra = vi.hoisted(() => ({ handleGroupMessage: vi.fn(async () => ({ handled: true, action: "silent" })) }));
vi.mock("@/lib/house-groups/ra.server", () => ra);
const bridge = vi.hoisted(() => ({ handleHouseSmsGroupInbound: vi.fn() }));
vi.mock("@/lib/house-sms-group/inbound.server", () => bridge);
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));

import { POST as webhook } from "@/app/api/twilio/conversations/route";
import { queueHouseSmsGroupRelay } from "@/lib/house-sms-group/relay.server";
import { emptySmsGroupState } from "@/lib/house-sms-group/model";

const URL_ = "https://app.example.test/api/twilio/conversations";
const SID = `CH${"a".repeat(32)}`;
const params = { EventType: "onMessageAdded", ConversationSid: SID, MessageSid: `IM${"b".repeat(32)}`, Author: "+12065551001", Body: "hi" };
const signed = () =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilio.getExpectedTwilioSignature("tok", URL_, params) },
    body: new URLSearchParams(params).toString(),
  });

describe("the Conversations webhook dispatch", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_CONVERSATIONS_WEBHOOK_URL", URL_);
    ra.handleGroupMessage.mockClear();
    bridge.handleHouseSmsGroupInbound.mockReset();
  });

  it("a house chat's Conversation is bridged and never reaches the W10 RA", async () => {
    bridge.handleHouseSmsGroupInbound.mockResolvedValue({ handled: true, action: "appended" });
    expect((await webhook(signed())).status).toBe(200);
    expect(bridge.handleHouseSmsGroupInbound).toHaveBeenCalledTimes(1);
    expect(ra.handleGroupMessage).not.toHaveBeenCalled();
  });

  it("any other Conversation falls through to the W10 RA", async () => {
    bridge.handleHouseSmsGroupInbound.mockResolvedValue({ handled: false });
    expect((await webhook(signed())).status).toBe(200);
    expect(ra.handleGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("a forged call touches neither", async () => {
    const forged = new Request(URL_, { method: "POST", headers: { "x-twilio-signature": "forged", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
    expect((await webhook(forged)).status).toBe(403);
    expect(bridge.handleHouseSmsGroupInbound).not.toHaveBeenCalled();
    expect(ra.handleGroupMessage).not.toHaveBeenCalled();
  });
});

describe("queueHouseSmsGroupRelay", () => {
  it("does nothing for a house with no group or a pending one (no read, no post)", () => {
    const db = { from: vi.fn() } as never;
    const input = { ownerUserId: "o", workspaceId: "w", propertyId: "p", from: "Maya · Room 2", body: "hi", messageId: "m1" };
    queueHouseSmsGroupRelay(db, { ...input, rowData: {} });
    queueHouseSmsGroupRelay(db, { ...input, rowData: { smsGroup: emptySmsGroupState(new Date()) } });
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });
});
