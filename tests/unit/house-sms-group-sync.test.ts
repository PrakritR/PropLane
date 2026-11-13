// The house SMS group sync: pending until two phones, one Conversation per house, people added and removed in place.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsError } from "@/lib/house-groups/conversations-gateway.server";
import { HOUSE, newMemory, threadId, WS, type Memory } from "../helpers/house-sms-group-memory";

vi.mock("server-only", () => ({}));
const mem = vi.hoisted(() => ({ current: null as unknown as Memory }));
vi.mock("@/lib/house-sms-group/store.server", async () => {
  const helper = await import("../helpers/house-sms-group-memory");
  const s = helper.storeOver(() => mem.current);
  return {
    threadIdFor: s.threadIdFor,
    ensureHouseThread: s.ensureHouseThread,
    loadHouseThread: s.loadHouseThread,
    loadHouseSmsGroup: s.loadHouseSmsGroup,
    saveSmsGroupState: s.saveSmsGroupState,
    listWorkspaceSmsGroups: s.listWorkspaceSmsGroups,
    findThreadByConversationSid: s.findThreadByConversationSid,
  };
});
const w10 = vi.hoisted(() => ({ settings: { enabled: false }, active: null as unknown }));
vi.mock("@/lib/house-groups/store.server", () => ({
  workspaceOwner: vi.fn(async () => "owner-1"),
  loadSettings: vi.fn(async () => w10.settings),
  loadActiveGroup: vi.fn(async () => w10.active),
}));
vi.mock("@/lib/house-chat/access.server", () => ({ loadWorkspaceHouse: vi.fn(async () => ({ label: "Ravenna" })) }));
vi.mock("@/lib/house-groups/residents.server", () => ({ loadHouseResidentCandidates: vi.fn() }));
const post = vi.hoisted(() => ({ fn: vi.fn(async () => ({ ok: true, messageSid: "IM1" })) }));
vi.mock("@/lib/house-sms-group/post.server", () => ({ postToHouseSmsGroup: post.fn }));
vi.mock("@/lib/house-sms-group/line.server", () => ({ resolveSmsGroupLine: vi.fn() }));

import { syncHouseSmsGroup, twilioGroupErrorText, type SmsGroupSyncDeps } from "@/lib/house-sms-group/sync.server";
import type { GroupResidentCandidate } from "@/lib/house-sms-group/model";

const LINE = "+12065550142";
const OWNER_PHONE = "+15103098345";
const db = {} as never;
const NOON = new Date("2026-11-12T20:00:00Z");

function resident(n: number, over: Partial<GroupResidentCandidate> = {}): GroupResidentCandidate {
  const key = `206555${1000 + n}`;
  return { phoneKey: key, phoneE164: `+1${key}`, userId: `u${n}`, firstName: `R${n}`, roomLabel: `Room ${n}`, moveIn: "2026-01-01", longTerm: true, verifiedPhone: true, optedOut: false, stopped: false, ...over };
}

function gateway() {
  const calls: string[] = [];
  let n = 0;
  const sid = () => `CH${String(++n).padStart(32, "0")}`;
  const gw = {
    calls,
    createConversation: vi.fn(async () => (calls.push("create"), { sid: sid() })),
    watchConversation: vi.fn(async () => void calls.push("watch")),
    addResident: vi.fn(async (_c: string, phone: string) => (calls.push(`add:${phone}`), { participantSid: `MB${String(++n).padStart(32, "0")}` })),
    addProplane: vi.fn(async (_c: string, line: string) => void calls.push(`proplane:${line}`)),
    postMessage: vi.fn(async () => ({ messageSid: "IM1" })),
    closeConversation: vi.fn(async () => void calls.push("close")),
    removeParticipant: vi.fn(async () => void calls.push("remove")),
  };
  return gw;
}

function deps(over: Partial<SmsGroupSyncDeps> & { residents?: GroupResidentCandidate[] } = {}): SmsGroupSyncDeps & { gw: ReturnType<typeof gateway> } {
  const gw = gateway();
  const { residents = [], ...rest } = over;
  return {
    gw,
    gateway: gw,
    now: () => NOON,
    line: async () => ({ ok: true, line: LINE, kind: "work" }),
    loadCandidates: async () => residents,
    isStopped: async () => false,
    shielded: async () => false,
    ...rest,
  };
}
const staff = [{ phoneE164: OWNER_PHONE, firstName: "Prakrit", userId: "owner-1" }];
const input = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, propertyId: HOUSE, enable: true, addStaff: staff, ...over });

beforeEach(() => {
  mem.current = newMemory();
  w10.settings = { enabled: false };
  w10.active = null;
  post.fn.mockClear();
});

describe("syncHouseSmsGroup", () => {
  it("leaves a house with no group alone unless asked to enable it", async () => {
    const d = deps();
    expect(await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d)).toMatchObject({ outcome: "no_group" });
    expect(d.gw.createConversation).not.toHaveBeenCalled();
  });

  it("with only the owner it is PENDING: members remembered, nothing created at Twilio", async () => {
    const d = deps();
    const r = await syncHouseSmsGroup(db, input(), d);
    expect(r).toMatchObject({ outcome: "pending", phones: 1 });
    expect(d.gw.createConversation).not.toHaveBeenCalled();
    const state = mem.current.states.get(threadId());
    expect(state).toMatchObject({ status: "pending", conversationSid: null, line: LINE, members: [{ kind: "staff", phoneKey: "5103098345" }] });
    // idempotent
    expect(await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d)).toMatchObject({ outcome: "pending" });
  });

  it("a second phone creates the Conversation, adds the phones, the line LAST, stores the SID and posts the intro", async () => {
    const d = deps({ residents: [resident(1)] });
    const r = await syncHouseSmsGroup(db, input(), d);
    expect(r).toMatchObject({ outcome: "created", phones: 2 });
    expect(d.gw.calls).toEqual(["create", "watch", `add:${OWNER_PHONE}`, `add:${resident(1).phoneE164}`, `proplane:${LINE}`]);
    const state = mem.current.states.get(threadId())!;
    expect(state).toMatchObject({ status: "active", line: LINE });
    expect(state.conversationSid).toMatch(/^CH/);
    expect(state.members.every((m) => m.participantSid)).toBe(true);
    expect(post.fn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "intro", propertyId: HOUSE }), expect.anything());
    // The second run changes nothing.
    d.gw.calls.length = 0;
    expect(await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d)).toMatchObject({ outcome: "unchanged" });
    expect(d.gw.calls).toEqual([]);
  });

  it("onboarding a resident into an existing group adds that phone only and welcomes them", async () => {
    const first = deps({ residents: [resident(1)] });
    await syncHouseSmsGroup(db, input(), first);
    const sid = mem.current.states.get(threadId())!.conversationSid;
    post.fn.mockClear();
    const next = deps({ residents: [resident(1), resident(2)] });
    const r = await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, next);
    expect(r).toMatchObject({ outcome: "updated", phones: 3 });
    expect(next.gw.createConversation).not.toHaveBeenCalled();
    expect(next.gw.addResident).toHaveBeenCalledTimes(1);
    expect(next.gw.addResident).toHaveBeenCalledWith(sid, resident(2).phoneE164);
    expect(post.fn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "welcome", text: expect.stringContaining("R2") }), expect.anything());
  });

  it("a resident who left the group or texted STOP is removed from the Conversation", async () => {
    await syncHouseSmsGroup(db, input(), deps({ residents: [resident(1), resident(2)] }));
    const d = deps({ residents: [resident(1), resident(2, { optedOut: true })] });
    const r = await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d);
    expect(r.outcome).toBe("updated");
    expect(d.gw.removeParticipant).toHaveBeenCalledTimes(1);
    expect(mem.current.states.get(threadId())!.members.map((m) => m.firstName)).toEqual(["Prakrit", "R1"]);
    const stopped = deps({ residents: [resident(1, { stopped: true })] });
    const r2 = await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, stopped);
    // Down to one phone: the Conversation is closed and the house is pending again.
    expect(r2.outcome).toBe("closed");
    expect(stopped.gw.closeConversation).toHaveBeenCalledTimes(1);
    expect(mem.current.states.get(threadId())).toMatchObject({ status: "pending", conversationSid: null });
  });

  it("a staff phone that texted STOP is dropped", async () => {
    await syncHouseSmsGroup(db, input(), deps({ residents: [resident(1), resident(2)] }));
    const d = deps({ residents: [resident(1), resident(2)], isStopped: async (p) => p === OWNER_PHONE });
    await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d);
    expect(mem.current.states.get(threadId())!.members.map((m) => m.phoneE164)).not.toContain(OWNER_PHONE);
  });

  it("a manager's removal of a resident keeps them out on the next sync", async () => {
    await syncHouseSmsGroup(db, input(), deps({ residents: [resident(1), resident(2)] }));
    await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE, removePhoneKeys: [resident(2).phoneKey] }, deps({ residents: [resident(1), resident(2)] }));
    await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, deps({ residents: [resident(1), resident(2)] }));
    expect(mem.current.states.get(threadId())!.members.map((m) => m.firstName)).toEqual(["Prakrit", "R1"]);
  });

  it("a short stay and an unverified phone never join", async () => {
    const d = deps({ residents: [resident(1, { longTerm: false }), resident(2, { verifiedPhone: false })] });
    expect(await syncHouseSmsGroup(db, input(), d)).toMatchObject({ outcome: "pending", phones: 1 });
  });

  it("refuses an identical phone set already live on another house, before Twilio does", async () => {
    const first = deps({ residents: [resident(1)] });
    await syncHouseSmsGroup(db, input(), first);
    const r = await syncHouseSmsGroup(db, input({ propertyId: "prop-2" }), deps({ residents: [resident(1)] }));
    expect(r.outcome).toBe("duplicate_member_set");
  });

  it("refuses while the PropLane house thread (W10) group serves the house", async () => {
    w10.settings = { enabled: true };
    w10.active = { id: "g1" };
    const d = deps({ residents: [resident(1)] });
    expect(await syncHouseSmsGroup(db, input(), d)).toMatchObject({ outcome: "w10_group_active" });
    expect(d.gw.createConversation).not.toHaveBeenCalled();
  });

  it("a workspace with no line is a refusal, never another number", async () => {
    const d = deps({ residents: [resident(1)], line: async () => ({ ok: false, reason: "no_line" }) });
    expect(await syncHouseSmsGroup(db, input(), d)).toMatchObject({ outcome: "no_line" });
    expect(d.gw.createConversation).not.toHaveBeenCalled();
  });

  it("a changed line rebuilds the Conversation on the new line", async () => {
    await syncHouseSmsGroup(db, input(), deps({ residents: [resident(1)] }));
    const d = deps({ residents: [resident(1)], line: async () => ({ ok: true, line: "+12065550199", kind: "work" }) });
    expect(await syncHouseSmsGroup(db, { workspaceId: WS, propertyId: HOUSE }, d)).toMatchObject({ outcome: "created" });
    expect(d.gw.calls).toContain("proplane:+12065550199");
    expect(mem.current.states.get(threadId())!.line).toBe("+12065550199");
  });

  it("a protected account outside production is never grouped", async () => {
    const d = deps({ residents: [resident(1)], shielded: async (p) => p === OWNER_PHONE });
    expect(await syncHouseSmsGroup(db, input(), d)).toMatchObject({ outcome: "shielded" });
    expect(d.gw.createConversation).not.toHaveBeenCalled();
  });

  it("a Twilio failure closes what it started, stores nothing active and says why", async () => {
    const d = deps({ residents: [resident(1)] });
    d.gw.addProplane.mockRejectedValueOnce(new ConversationsError("add proplane failed (50435)", "50435"));
    const r = await syncHouseSmsGroup(db, input(), d);
    expect(r.outcome).toBe("error");
    expect(r.detail).toBe(twilioGroupErrorText("50435"));
    expect(d.gw.closeConversation).toHaveBeenCalledTimes(1);
    expect(mem.current.states.get(threadId())).toMatchObject({ status: "pending", conversationSid: null });
  });

  it("without Twilio configured it errors instead of pretending", async () => {
    const d = deps({ residents: [resident(1)], gateway: null });
    expect(await syncHouseSmsGroup(db, input(), d)).toMatchObject({ outcome: "error", detail: "twilio_not_configured" });
  });
});
