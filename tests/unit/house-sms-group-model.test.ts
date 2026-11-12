// The house SMS group, pure half: who is in it, what a manager sees, what Twilio's rules mean here.
import { describe, expect, it } from "vitest";
import {
  emptySmsGroupState,
  groupTextFor,
  inboundLineId,
  maskPhoneLast4,
  memberSetKey,
  planMembership,
  readSmsGroupState,
  selectResidentMembers,
  smsAuthorLabel,
  withSmsGroupState,
  type GroupResidentCandidate,
  type SmsGroupMember,
} from "@/lib/house-sms-group/model";

const SID = `CH${"a".repeat(32)}`;
const now = new Date("2026-11-12T20:00:00Z");

function res(n: number, over: Partial<GroupResidentCandidate> = {}): GroupResidentCandidate {
  const key = `206555${String(1000 + n)}`;
  return { phoneKey: key, phoneE164: `+1${key}`, userId: `u${n}`, firstName: `R${n}`, roomLabel: `Room ${n}`, moveIn: `2026-0${(n % 9) + 1}-01`, longTerm: true, verifiedPhone: true, optedOut: false, stopped: false, ...over };
}
function staff(key: string, over: Partial<SmsGroupMember> = {}): SmsGroupMember {
  return { phoneKey: key, phoneE164: `+1${key}`, kind: "staff", firstName: "Prakrit", roomLabel: "", userId: null, participantSid: null, addedAt: now.toISOString(), ...over };
}

describe("selectResidentMembers (opt-out, not opt-in)", () => {
  it("takes a current long-term resident with a verified phone who has not left or texted STOP", () => {
    const { members, excluded } = selectResidentMembers([res(1)], []);
    expect(members.map((m) => m.firstName)).toEqual(["R1"]);
    expect(excluded).toEqual([]);
  });
  it("excludes a short stay, an unverified phone, a left-group resident and a STOP, each for its own reason", () => {
    const { members, excluded } = selectResidentMembers(
      [res(1, { longTerm: false }), res(2, { verifiedPhone: false }), res(3, { optedOut: true }), res(4, { stopped: true }), res(5)],
      [],
    );
    expect(members.map((m) => m.firstName)).toEqual(["R5"]);
    expect(excluded.map((e) => e.reason).sort()).toEqual(["left_group", "short_stay", "stopped", "unverified_phone"]);
  });
  it("keeps a phone a manager removed out, and counts two candidates on one phone once", () => {
    const a = res(1);
    const { members, excluded } = selectResidentMembers([a, { ...a, firstName: "Twin", moveIn: "2026-09-09" }, res(2)], [res(2).phoneKey]);
    expect(members).toHaveLength(1);
    expect(excluded.map((e) => e.reason).sort()).toEqual(["duplicate", "removed_by_manager"]);
  });
  it("does not duplicate a phone already held by staff", () => {
    const r = res(1);
    expect(selectResidentMembers([r], [], new Set([r.phoneKey])).members).toEqual([]);
  });
});

describe("planMembership", () => {
  it("puts staff first, residents by move-in, and reports who was added and removed", () => {
    const current = [staff("5103098345", { participantSid: "MB1" }), { ...staff("2065559999", { kind: "resident", firstName: "Gone" }), participantSid: "MB2" }];
    const plan = planMembership({ current, staff: [staff("5103098345")], residents: [res(1)], now });
    expect(plan.desired.map((m) => m.phoneKey)).toEqual(["5103098345", res(1).phoneKey]);
    expect(plan.desired[0]!.participantSid).toBe("MB1");
    expect(plan.added.map((m) => m.firstName)).toEqual(["R1"]);
    expect(plan.removed.map((m) => m.phoneKey)).toEqual(["2065559999"]);
  });
  it("drops a staff phone that texted STOP", () => {
    const plan = planMembership({ current: [], staff: [staff("5103098345")], residents: [], stoppedPhoneKeys: new Set(["5103098345"]), now });
    expect(plan.desired).toEqual([]);
  });
  it("caps the group at nine phones and reports the overflow", () => {
    const residents = Array.from({ length: 11 }, (_, i) => res(i + 1));
    const plan = planMembership({ current: [], staff: [staff("5103098345")], residents, now });
    expect(plan.desired).toHaveLength(9);
    expect(plan.overflow).toBe(3);
  });
});

describe("memberSetKey", () => {
  it("is the same for the same phones in any order and differs by line and by phone set", () => {
    expect(memberSetKey("+12065550142", ["2", "1"].map((d) => d.repeat(10)))).toBe(memberSetKey("+12065550142", ["1", "2"].map((d) => d.repeat(10))));
    expect(memberSetKey("+12065550142", ["1111111111", "2222222222"])).not.toBe(memberSetKey("+12065550199", ["1111111111", "2222222222"]));
    expect(memberSetKey("+12065550142", ["1111111111", "2222222222"])).not.toBe(memberSetKey("+12065550142", ["1111111111", "3333333333"]));
  });
});

describe("a manager's view and the thread lines", () => {
  it("masks a phone to its last four digits", () => {
    expect(maskPhoneLast4("+15103098345")).toBe("•••• 8345");
    expect(maskPhoneLast4("")).toBe("••••");
  });
  it("draws a resident as first name and room, staff as the first name", () => {
    expect(smsAuthorLabel({ kind: "resident", firstName: "Maya", roomLabel: "Room 2" })).toBe("Maya · Room 2");
    expect(smsAuthorLabel({ kind: "staff", firstName: "Prakrit", roomLabel: "" })).toBe("Prakrit");
    expect(smsAuthorLabel({ kind: "staff", firstName: "", roomLabel: "" })).toBe("Team");
  });
  it("labels an outbound line and keys an inbound one on the Twilio MessageSid", () => {
    expect(groupTextFor("Maya · Room 2", " hi all ")).toBe("Maya · Room 2: hi all");
    expect(groupTextFor("x", "y".repeat(2000)).length).toBeLessThanOrEqual(1000);
    expect(inboundLineId(" IM123 ")).toBe("sms-group:IM123");
  });
});

describe("the stored state", () => {
  it("round-trips on row_data.smsGroup (a top-level key the house chat's allowlist rebuild never touches)", () => {
    const state = { ...emptySmsGroupState(now), status: "active" as const, conversationSid: SID, line: "+12065550142", members: [staff("5103098345", { participantSid: "MB1" })] };
    const row = withSmsGroupState({ houseChat: { version: 1 }, messages: [] }, state);
    expect(row.houseChat).toEqual({ version: 1 });
    expect(readSmsGroupState(row)).toMatchObject({ status: "active", conversationSid: SID, line: "+12065550142", members: [{ phoneKey: "5103098345", participantSid: "MB1" }] });
  });
  it("reads nothing for a house with no group and downgrades a group whose sid is malformed to pending", () => {
    expect(readSmsGroupState({})).toBeNull();
    expect(readSmsGroupState({ smsGroup: { version: 1, status: "active", conversationSid: "nope", members: [] } })).toMatchObject({ status: "pending", conversationSid: null });
  });
  it("ignores a member without a ten digit phone key", () => {
    const state = readSmsGroupState({ smsGroup: { version: 1, members: [{ phoneKey: "12", phoneE164: "+1" }, { phoneKey: "5103098345", phoneE164: "+15103098345" }] } });
    expect(state?.members.map((m) => m.phoneKey)).toEqual(["5103098345"]);
  });
});
