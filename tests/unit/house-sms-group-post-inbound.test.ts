// The two directions of the house SMS group: in-app -> SMS (billed, keyed) and SMS -> the one in-app house chat.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newMemory, OWNER, threadId, WS, HOUSE, type Memory } from "../helpers/house-sms-group-memory";
import { emptySmsGroupState, type SmsGroupMember, type SmsGroupState } from "@/lib/house-sms-group/model";

vi.mock("server-only", () => ({}));
const mem = vi.hoisted(() => ({ current: null as unknown as Memory }));
const thread = vi.hoisted(() => ({ row: null as null | { id: string; rowData: Record<string, unknown>; ownerUserId: string; workspaceId: string; updatedAt: null } }));
vi.mock("@/lib/house-sms-group/store.server", async () => {
  const helper = await import("../helpers/house-sms-group-memory");
  const s = helper.storeOver(() => mem.current);
  return {
    threadIdFor: s.threadIdFor,
    loadHouseSmsGroup: s.loadHouseSmsGroup,
    saveSmsGroupState: s.saveSmsGroupState,
    findThreadByConversationSid: vi.fn(async () => thread.row),
  };
});
const wallet = vi.hoisted(() => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true })),
  finishCommsCredit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/comms-billing/wallet.server", () => wallet);
vi.mock("@/lib/house-groups/store.server", () => ({
  workspaceOwner: vi.fn(async () => "owner-1"),
  recordOptOut: vi.fn(async () => true),
  loadPreferences: vi.fn(async () => new Map()),
}));
const chat = vi.hoisted(() => ({ appendHouseLine: vi.fn(async () => ({ ok: true, posted: true })) }));
vi.mock("@/lib/house-chat/store.server", () => chat);
const sync = vi.hoisted(() => ({ syncHouseSmsGroup: vi.fn(async () => ({ outcome: "updated" })) }));
vi.mock("@/lib/house-sms-group/sync.server", () => sync);
vi.mock("@/lib/sms-consent", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sms-consent")>()), isPhoneOptedOut: vi.fn(async () => false) }));

import { postToHouseSmsGroup } from "@/lib/house-sms-group/post.server";
import { handleHouseSmsGroupInbound } from "@/lib/house-sms-group/inbound.server";

const SID = `CH${"a".repeat(32)}`;
const NOON = new Date("2026-11-12T20:00:00Z");
const MIDNIGHT = new Date("2026-11-13T08:00:00Z");
const db = {} as never;

const member = (key: string, over: Partial<SmsGroupMember> = {}): SmsGroupMember => ({
  phoneKey: key, phoneE164: `+1${key}`, kind: "resident", firstName: "Maya", roomLabel: "Room 2", userId: "u-maya", participantSid: `MB${key}`, addedAt: "2026-11-01T00:00:00Z", ...over,
});
const active = (members: SmsGroupMember[]): SmsGroupState => ({ ...emptySmsGroupState(NOON), status: "active", conversationSid: SID, line: "+12065550142", members });

function gw() {
  return { postMessage: vi.fn(async () => ({ messageSid: "IM1" })) } as never as import("@/lib/house-groups/types").ConversationsGateway & { postMessage: ReturnType<typeof vi.fn> };
}
const base = { workspaceId: WS, propertyId: HOUSE, ownerUserId: OWNER, text: "Maya · Room 2: trash is out", kind: "relay" as const, idempotencyKey: "relay:house-reply:abc" };

beforeEach(() => {
  mem.current = newMemory();
  mem.current.threads.set(threadId(), { propertyId: HOUSE, workspaceId: WS });
  wallet.reserveCommsCredit.mockClear().mockResolvedValue({ allowed: true });
  wallet.finishCommsCredit.mockClear();
  chat.appendHouseLine.mockClear().mockResolvedValue({ ok: true, posted: true });
  sync.syncHouseSmsGroup.mockClear();
  thread.row = null;
});

describe("postToHouseSmsGroup (in-app -> SMS)", () => {
  it("answers no_group while the group is pending or absent and never calls Twilio", async () => {
    const g = gw();
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false })).toMatchObject({ ok: false, reason: "no_group" });
    mem.current.states.set(threadId(), { ...emptySmsGroupState(NOON), members: [member("2065551001")] });
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false })).toMatchObject({ ok: false, reason: "no_group" });
    expect(g.postMessage).not.toHaveBeenCalled();
  });

  it("reserves phones x segments from the OWNER's wallet BEFORE Twilio, posts once, and settles", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002"), member("5103098345", { kind: "staff" })]));
    const g = gw();
    const order: string[] = [];
    wallet.reserveCommsCredit.mockImplementationOnce(async () => (order.push("reserve"), { allowed: true }));
    g.postMessage.mockImplementationOnce(async () => (order.push("post"), { messageSid: "IM9" }));
    const r = await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false });
    expect(r).toMatchObject({ ok: true, messageSid: "IM9" });
    expect(order).toEqual(["reserve", "post"]);
    expect(wallet.reserveCommsCredit).toHaveBeenCalledWith(db, expect.objectContaining({ managerUserId: OWNER, workspaceId: WS, meter: "sms_outbound_segment", quantity: 3 }));
    expect(wallet.finishCommsCredit).toHaveBeenCalledWith(db, OWNER, expect.any(String));
    // A retry with the same key goes out once.
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false })).toMatchObject({ ok: true, duplicate: true });
    expect(g.postMessage).toHaveBeenCalledTimes(1);
  });

  it("a refused wallet sends nothing and frees the key", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002")]));
    wallet.reserveCommsCredit.mockResolvedValueOnce({ allowed: false });
    const g = gw();
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false })).toMatchObject({ ok: false, detail: "budget" });
    expect(g.postMessage).not.toHaveBeenCalled();
    expect(mem.current.states.get(threadId())!.postKeys).toEqual([]);
  });

  it("a Twilio failure hands the credit back and frees the key", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002")]));
    const g = gw();
    g.postMessage.mockRejectedValueOnce(new Error("post message failed"));
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async () => false })).toMatchObject({ ok: false, reason: "provider_error" });
    expect(wallet.finishCommsCredit).toHaveBeenCalledWith(db, OWNER, expect.any(String), true);
    expect(mem.current.states.get(threadId())!.postKeys).toEqual([]);
  });

  it("PropLane's own posts keep quiet hours; a person's relayed line does not", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002")]));
    const g = gw();
    expect(await postToHouseSmsGroup(db, { ...base, kind: "welcome", idempotencyKey: "w" }, { gateway: g, now: () => MIDNIGHT, shielded: async () => false })).toMatchObject({ ok: false, reason: "quiet_hours" });
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => MIDNIGHT, shielded: async () => false })).toMatchObject({ ok: true });
  });

  it("a protected account in the group refuses the post outside production", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002")]));
    const g = gw();
    expect(await postToHouseSmsGroup(db, base, { gateway: g, now: () => NOON, shielded: async (p) => p.endsWith("1002") })).toMatchObject({ ok: false, detail: "protected_account_shielded" });
    expect(g.postMessage).not.toHaveBeenCalled();
  });

  it("never posts a card number", async () => {
    mem.current.states.set(threadId(), active([member("2065551001"), member("2065551002")]));
    const g = gw();
    await postToHouseSmsGroup(db, { ...base, text: "pay with 4242 4242 4242 4242 ok" }, { gateway: g, now: () => NOON, shielded: async () => false });
    expect(String(g.postMessage.mock.calls[0]![1])).not.toContain("4242 4242");
  });
});

describe("handleHouseSmsGroupInbound (SMS -> the one in-app house chat)", () => {
  const msg = (over: Record<string, unknown> = {}) => ({ conversationSid: SID, messageSid: `IM${"b".repeat(32)}`, author: "+12065551001", body: "who has the garage key?", mediaCount: 0, ...over });
  const withThread = (members: SmsGroupMember[]) => {
    thread.row = { id: threadId(), rowData: {}, ownerUserId: OWNER, workspaceId: WS, updatedAt: null };
    mem.current.states.set(threadId(), active(members));
    (thread.row as { rowData: Record<string, unknown> }).rowData = { smsGroup: active(members) };
  };
  const live = (key: string) => async () => [{ phoneKey: key, longTerm: true, optedOut: false, stopped: false }] as never;

  it("is not handled when the Conversation is no house chat's (the W10 RA groups fall through)", async () => {
    expect(await handleHouseSmsGroupInbound(db, msg())).toEqual({ handled: false });
  });

  it("never bridges PropLane's own post back (no echo loop)", async () => {
    withThread([member("2065551001")]);
    expect(await handleHouseSmsGroupInbound(db, msg({ author: "proplane" }))).toMatchObject({ handled: true, action: "own_message" });
    expect(chat.appendHouseLine).not.toHaveBeenCalled();
  });

  it("appends a member's text as one line, drawn by first name and room, keyed on the MessageSid", async () => {
    withThread([member("2065551001"), member("5103098345", { kind: "staff", firstName: "Prakrit", roomLabel: "" })]);
    const r = await handleHouseSmsGroupInbound(db, msg(), { loadCandidates: live("2065551001") });
    expect(r).toMatchObject({ handled: true, action: "appended" });
    expect(chat.appendHouseLine).toHaveBeenCalledWith(db, threadId(), { id: `sms-group:IM${"b".repeat(32)}`, from: "Maya · Room 2", body: "who has the garage key?", actorUserId: "u-maya" });
    // A staff text is drawn by first name only.
    await handleHouseSmsGroupInbound(db, msg({ author: "+15103098345", messageSid: "IMstaff" }));
    expect(chat.appendHouseLine).toHaveBeenLastCalledWith(db, threadId(), expect.objectContaining({ from: "Prakrit" }));
  });

  it("a Twilio retry appends once (the line id dedupes)", async () => {
    withThread([member("2065551001")]);
    chat.appendHouseLine.mockResolvedValueOnce({ ok: true, posted: false });
    expect(await handleHouseSmsGroupInbound(db, msg(), { loadCandidates: live("2065551001") })).toMatchObject({ action: "duplicate" });
  });

  it("drops a text from a phone that is not a member", async () => {
    withThread([member("2065551001")]);
    expect(await handleHouseSmsGroupInbound(db, msg({ author: "+12065559999" }))).toMatchObject({ handled: true, action: "not_a_member" });
    expect(chat.appendHouseLine).not.toHaveBeenCalled();
  });

  it("re-derives a resident from occupancy: moved out, left or STOP is dropped and the group re-synced", async () => {
    withThread([member("2065551001")]);
    const r = await handleHouseSmsGroupInbound(db, msg(), { loadCandidates: async () => [] });
    expect(r).toMatchObject({ handled: true, action: "not_current_resident" });
    expect(chat.appendHouseLine).not.toHaveBeenCalled();
    expect(sync.syncHouseSmsGroup).toHaveBeenCalledTimes(1);
  });

  it("when occupancy cannot be read the stored list stands, but the STOP ledger still applies", async () => {
    withThread([member("2065551001")]);
    const unreadable = async () => {
      throw new Error("occupancy down");
    };
    expect(await handleHouseSmsGroupInbound(db, msg(), { loadCandidates: unreadable })).toMatchObject({ action: "appended" });
    const { isPhoneOptedOut } = await import("@/lib/sms-consent");
    vi.mocked(isPhoneOptedOut).mockResolvedValueOnce(true);
    chat.appendHouseLine.mockClear();
    expect(await handleHouseSmsGroupInbound(db, msg({ messageSid: "IM2" }), { loadCandidates: unreadable })).toMatchObject({ action: "not_current_resident" });
    expect(chat.appendHouseLine).not.toHaveBeenCalled();
  });

  it("LEAVE GROUP opts a resident out, removes the phone and tells the rest; nothing is bridged", async () => {
    withThread([member("2065551001"), member("2065551002")]);
    const store = await import("@/lib/house-groups/store.server");
    const r = await handleHouseSmsGroupInbound(db, msg({ body: "leave group" }), { loadCandidates: live("2065551001"), post: { gateway: gw(), now: () => NOON, shielded: async () => false } });
    expect(r).toMatchObject({ handled: true, action: "left" });
    expect(store.recordOptOut).toHaveBeenCalledWith(db, WS, "2065551001");
    expect(sync.syncHouseSmsGroup).toHaveBeenCalledWith(db, expect.objectContaining({ removePhoneKeys: ["2065551001"] }), expect.anything());
    expect(chat.appendHouseLine).not.toHaveBeenCalled();
  });

  it("ignores a closed/pending group and an empty text", async () => {
    thread.row = { id: threadId(), rowData: {}, ownerUserId: OWNER, workspaceId: WS, updatedAt: null };
    expect(await handleHouseSmsGroupInbound(db, msg())).toMatchObject({ handled: true, action: "not_active" });
    withThread([member("2065551001")]);
    expect(await handleHouseSmsGroupInbound(db, msg({ body: "  " }), { loadCandidates: live("2065551001") })).toMatchObject({ action: "empty" });
  });
});

export type { SmsGroupMember };
