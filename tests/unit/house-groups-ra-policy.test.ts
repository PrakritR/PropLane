// The RA's manners: quiet by default, speaks when addressed, never names anyone, nothing 10 pm - 8 am but an emergency.
import { describe, expect, it } from "vitest";
import { composeFactReply, type LookupLike } from "@/lib/house-groups/facts";
import {
  COMPLAINT_ACK,
  introText,
  leaverGoodbye,
  memberLine,
  RULES_REMINDER_NOISE,
} from "@/lib/house-groups/copy";
import {
  classifyGroupText,
  groupPreferenceCommand,
  planDueCheck,
  planGroupReply,
  UNANSWERED_WAIT_MS,
  type RaContext,
} from "@/lib/house-groups/ra-policy";
import { inHouseQuietHours, nextPacificMorning, pacificDayKey, pacificDayStart } from "@/lib/house-groups/time";
import { isGsm7, smsSegmentCount } from "@/lib/one-number/segments";

// Oct 18 2026 is PDT (UTC-7): 19:00Z = noon Pacific, 07:00Z next day = midnight.
const NOON = new Date("2026-10-18T19:00:00Z");
const MIDNIGHT = new Date("2026-10-19T07:00:00Z");
const ctx = (over: Partial<RaContext> = {}): RaContext => ({ now: NOON, postsToday: 0, maxPostsPerDay: 4, recentRuleFlags: 0, ...over });
const plan = (text: string, over: Partial<RaContext> = {}) => planGroupReply(classifyGroupText(text), ctx(over));

describe("house time", () => {
  it("quiet hours are 10 pm to 8 am Pacific", () => {
    expect(inHouseQuietHours(new Date("2026-10-18T04:59:00Z"))).toBe(false); // 9:59 pm
    expect(inHouseQuietHours(new Date("2026-10-18T05:00:00Z"))).toBe(true); // 10:00 pm
    expect(inHouseQuietHours(new Date("2026-10-18T14:59:00Z"))).toBe(true); // 7:59 am
    expect(inHouseQuietHours(new Date("2026-10-18T15:00:00Z"))).toBe(false); // 8:00 am
  });
  it("holds a night text until 8 am and counts the Pacific day", () => {
    expect(nextPacificMorning(MIDNIGHT).toISOString()).toBe("2026-10-19T15:00:00.000Z");
    expect(pacificDayKey(new Date("2026-10-19T06:30:00Z"))).toBe("2026-10-18");
    expect(pacificDayStart(NOON).toISOString()).toBe("2026-10-18T07:00:00.000Z");
  });
});

describe("classifyGroupText", () => {
  it("reads who is addressed and what is asked", () => {
    expect(classifyGroupText("PropLane, what's the wifi password?")).toMatchObject({ addressed: true, houseQuestion: true });
    expect(classifyGroupText("@proplane trash day?").addressed).toBe(true);
    expect(classifyGroupText("what day is trash?")).toMatchObject({ addressed: false, houseQuestion: true });
    expect(classifyGroupText("anyone want pizza tonight?")).toMatchObject({ addressed: false, houseQuestion: false, flag: null });
    expect(classifyGroupText("lol that movie was great")).toMatchObject({ addressed: false, houseQuestion: false, flag: null });
  });
  it("flags complaints, rule issues and safety words, and reads emergencies", () => {
    expect(classifyGroupText("someone is blasting music again, so loud").flag).toBe("rule");
    expect(classifyGroupText("the dishes are disgusting, sick of this").flag).toBe("rule");
    expect(classifyGroupText("I am so fed up with how this house is run").flag).toBe("complaint");
    expect(classifyGroupText("I feel unsafe here").flag).toBe("safety");
    expect(classifyGroupText("he keeps harassing me").flag).toBe("harassment");
    expect(classifyGroupText("that was a racist comment").flag).toBe("discrimination");
    expect(classifyGroupText("I smell a gas leak in the kitchen").emergency).toBe(true);
    expect(classifyGroupText("fired up for the game").emergency).toBe(false);
  });
  it("reads leave / join as the whole text only", () => {
    expect(groupPreferenceCommand("Leave group")).toBe("leave");
    expect(groupPreferenceCommand("please leave the group")).toBe("leave");
    expect(groupPreferenceCommand("join group")).toBe("join");
    expect(groupPreferenceCommand("join")).toBeNull();
    expect(groupPreferenceCommand("can someone leave group chat rules")).toBeNull();
  });
});

describe("planGroupReply", () => {
  it("stays silent on small talk", () => {
    expect(plan("anyone want pizza tonight?")).toMatchObject({ groupReply: null, checkAt: null, escalate: null, followUpPrivately: false });
  });

  it("answers when addressed, in the day", () => {
    expect(plan("PropLane, when is trash pickup?").groupReply).toBe("answer");
  });

  it("holds an addressed question until morning at night", () => {
    const p = plan("PropLane, what's the wifi?", { now: MIDNIGHT });
    expect(p.groupReply).toBeNull();
    expect(p.held).toBe("quiet_hours");
    expect(p.checkAt?.toISOString()).toBe("2026-10-19T15:00:00.000Z");
  });

  it("answers privately once the daily cap is reached", () => {
    const p = plan("PropLane, what's the wifi?", { postsToday: 4 });
    expect(p).toMatchObject({ groupReply: null, answerPrivately: true, held: "daily_cap" });
  });

  it("gives housemates ten minutes before answering an unaddressed house question", () => {
    const p = plan("what day is trash?");
    expect(p.groupReply).toBeNull();
    expect(p.checkAt?.getTime()).toBe(NOON.getTime() + UNANSWERED_WAIT_MS);
  });

  it("acknowledges a complaint in the group and follows up one-on-one, without naming anyone", () => {
    const p = plan("I am so fed up with how this house is run");
    expect(p).toMatchObject({ groupReply: "complaint_ack", followUpPrivately: true, escalate: null });
    expect(COMPLAINT_ACK).toBe("Got it, I'll follow up with you directly.");
  });

  it("reminds neutrally on the second rule issue and escalates to the manager on the third", () => {
    expect(plan("so loud again, music at 2am", { recentRuleFlags: 0 }).groupReply).toBe("complaint_ack");
    expect(plan("so loud again, music at 2am", { recentRuleFlags: 1 })).toMatchObject({ groupReply: "rules_reminder", escalate: null });
    expect(plan("so loud again, music at 2am", { recentRuleFlags: 2 })).toMatchObject({
      groupReply: null,
      escalate: { category: "repeated_rules", urgent: false },
    });
  });

  it("sends safety, harassment and discrimination to the team and says nothing in the group, even at night", () => {
    for (const [text, category] of [
      ["I feel unsafe here", "safety"],
      ["he keeps harassing me", "harassment"],
      ["that was a racist comment", "discrimination"],
    ] as const) {
      for (const now of [NOON, MIDNIGHT]) {
        expect(plan(text, { now })).toMatchObject({ groupReply: null, escalate: { category }, followUpPrivately: false });
      }
    }
  });

  it("an emergency word ignores quiet hours and the cap", () => {
    const p = plan("there is a gas leak!", { now: MIDNIGHT, postsToday: 99 });
    expect(p).toMatchObject({ emergency: true, escalate: { category: "safety", urgent: true } });
  });

  it("holds a night complaint's follow-up until morning and posts nothing", () => {
    const p = plan("I am so fed up with how this house is run", { now: MIDNIGHT });
    expect(p).toMatchObject({ groupReply: null, held: "quiet_hours", followUpPrivately: true });
    expect(p.checkAt?.toISOString()).toBe("2026-10-19T15:00:00.000Z");
  });

  it("does not answer a leave / join command in the group", () => {
    expect(plan("leave group")).toMatchObject({ groupReply: null, checkAt: null });
  });
});

describe("planDueCheck", () => {
  it("answers an unanswered question, or skips when a housemate did", () => {
    expect(planDueCheck("question", ctx()).act).toBe("answer_group");
    expect(planDueCheck("question", ctx({ answeredByPerson: true })).act).toBe("skip");
  });
  it("waits for morning at night and goes private at the cap", () => {
    expect(planDueCheck("question", ctx({ now: MIDNIGHT }))).toMatchObject({ act: "wait" });
    expect(planDueCheck("question", ctx({ postsToday: 4 })).act).toBe("answer_private");
    expect(planDueCheck("followup", ctx()).act).toBe("follow_up");
    expect(planDueCheck("followup", ctx({ now: MIDNIGHT })).act).toBe("wait");
  });
});

describe("RA copy", () => {
  const members = [
    { firstName: "Maya", roomLabel: "Room 1" },
    { firstName: "Sam", roomLabel: "Room 2" },
  ];
  it("introduces people by first name and room only, in plain GSM-7", () => {
    const text = introText(members as never, { replacing: false });
    expect(text).toContain("Maya (Room 1), Sam (Room 2)");
    expect(isGsm7(text)).toBe(true);
    expect(memberLine({ firstName: "", roomLabel: "" })).toBe("A housemate");
  });
  it("says the old thread is retired when a group is replaced", () => {
    const text = introText(members as never, { replacing: true, newcomers: [members[1]] as never });
    expect(text.startsWith("This is the new house thread, the old one is retired.")).toBe(true);
    expect(text).toContain("Welcome Sam (Room 2)");
  });
  it("keeps every canned line to one or two segments with no emoji, curly quotes or long dashes", () => {
    for (const line of [COMPLAINT_ACK, RULES_REMINDER_NOISE, leaverGoodbye("Maya", "5259 Brooklyn", null)]) {
      expect(isGsm7(line)).toBe(true);
      expect(smsSegmentCount(line)).toBeLessThanOrEqual(2);
      expect(line).not.toMatch(/[—–‘’“”]/);
    }
  });
});

describe("composeFactReply", () => {
  const lookup = (over: Partial<LookupLike>): LookupLike => ({ found: true, mustEscalate: null, answers: [], houseDetails: [], ...over });

  it("answers from an approved entry", () => {
    const r = composeFactReply(lookup({ answers: [{ question: "Trash day?", answer: "Trash goes out Tuesday night." }] }), "Sam");
    expect(r).toEqual({ kind: "group", text: "Sam, Trash goes out Tuesday night." });
  });

  it("never posts a door code or a Wi-Fi password in the group: the asker gets it privately", () => {
    const r = composeFactReply(
      lookup({ houseDetails: [{ house: "H", section: "Wi-Fi", rows: [{ label: "Network", value: "Lakeview" }, { label: "Password", value: "hunter2" }] }] }),
      "Maya",
    );
    expect(r.kind).toBe("private");
    if (r.kind === "private") {
      expect(r.groupText).toContain("Lakeview");
      expect(r.groupText).not.toContain("hunter2");
      expect(r.privateText).toContain("hunter2");
    }
    const door = composeFactReply(
      lookup({ houseDetails: [{ house: "H", section: "Access", rows: [{ label: "Door code", value: "4821" }] }] }),
      "Maya",
    );
    expect(door.kind).toBe("private");
    if (door.kind === "private") expect(door.groupText).not.toContain("4821");
  });

  it("never states an amount", () => {
    const r = composeFactReply(
      lookup({ houseDetails: [{ house: "H", section: "Parking", rows: [{ label: "Spot", value: "Driveway" }, { label: "Monthly fee", value: "$75" }] }] }),
      "Sam",
    );
    expect(JSON.stringify(r)).not.toContain("75");
    expect(JSON.stringify(r)).toContain("Driveway");
    const entry = composeFactReply(lookup({ answers: [{ question: "q", answer: "Parking is $50 a month." }] }), "Sam");
    expect(entry.kind).toBe("unknown");
  });

  it("hands money, legal, safety and fair housing to the team, and says so honestly when nothing covers it", () => {
    expect(composeFactReply(lookup({ mustEscalate: "money" }), "Sam").kind).toBe("escalate");
    expect(composeFactReply(lookup({ found: false }), "Sam").kind).toBe("unknown");
  });
});
