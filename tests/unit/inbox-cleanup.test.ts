/**
 * The inbox cleanup keeps every message a person typed and removes only automated noise. Pure classifier tests (the script
 * `scripts/inbox-cleanup.mts` is a thin shell over them).
 */
import { describe, expect, it } from "vitest";
import {
  assertInboxCleanupWriteAllowed,
  isAutomatedAssistantNotice,
  isAutomatedTeamLine,
  isDeletableOwnerThread,
  isLeadNudgeBody,
  planAssistantNoticeCleanup,
  planLeadNudgeCleanup,
  planTeamThreadCleanup,
  type ThreadRow,
} from "@/lib/communication/inbox-cleanup";

const NOW = new Date("2026-11-12T12:00:00Z");
const OLD = "2026-11-10T09:00:00.000Z";
const FRESH = "2026-11-12T09:00:00.000Z";
const thread = (id: string, messages: unknown[], extra: Partial<ThreadRow> = {}): ThreadRow => ({ id, thread_type: "agent_notice", row_data: { messages }, ...extra });

describe("(a) Assistant notices", () => {
  const notice = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id: `agent_notice_msg_${id}`, from: "PropLane Assistant", outbound: false, at, body: "Check-in tomorrow", noticeType: "agent_reminder", ...extra });
  it("removes automated notices older than 24h and keeps the rest", () => {
    const human = { id: "m1", from: "Ambika Mago", outbound: true, at: OLD, body: "Hi" };
    const chatAnswer = { id: "sms_out_abc", from: "PropLane Assistant", outbound: false, at: OLD, body: "Is this about Ambika or Vinod?", channel: "sms" };
    const plan = planAssistantNoticeCleanup(thread("agent_notice_u1", [notice("a", OLD), notice("b", FRESH), human, chatAnswer, notice("c", OLD, { noticeType: undefined })]), NOW);
    expect(plan.remove.map((m) => m.id)).toEqual(["agent_notice_msg_a", "agent_notice_msg_c"]);
    expect(plan.keep.map((m) => m.id)).toEqual(["agent_notice_msg_b", "m1", "sms_out_abc"]);
  });
  it("never removes a message a person typed, even one stamped like a notice", () => {
    expect(isAutomatedAssistantNotice({ id: "agent_notice_msg_x", from: "PropLane Assistant", outbound: true })).toBe(false);
    expect(isAutomatedAssistantNotice({ id: "m", from: "prakritramachandran@gmail.com", outbound: true, channel: "sms" })).toBe(false);
    expect(isAutomatedAssistantNotice({ id: "m2", from: "Property manager" })).toBe(false);
  });
  it("an unreadable time is never treated as old, and a second pass finds nothing (idempotent)", () => {
    expect(planAssistantNoticeCleanup(thread("t", [notice("a", "yesterday-ish")]), NOW).remove).toHaveLength(0);
    const first = planAssistantNoticeCleanup(thread("t", [notice("a", OLD), notice("b", FRESH)]), NOW);
    expect(planAssistantNoticeCleanup(thread("t", first.keep), NOW).remove).toHaveLength(0);
  });
});

describe("(b) Team chat", () => {
  const line = (id: string) => ({ id: `action-event:${id}:team`, from: "PropLane", channel: "proplane", outbound: true, body: "Payment reminder sent: Late fee …" });
  it("removes PropLane's automated lines and keeps human messages", () => {
    const human = { id: "t1", from: "Dev Patel", outbound: true, body: "On my way to Room 4" };
    const plan = planTeamThreadCleanup(thread("team-thread:u:ws:w", [line("1"), human, line("2")], { thread_type: "team" }));
    expect(plan.remove).toHaveLength(2);
    expect(plan.keep).toEqual([human]);
    expect(isAutomatedTeamLine({ id: "x", from: "Dev Patel", channel: "proplane" })).toBe(false);
  });
});

describe("(c) a managed owner's system-only thread", () => {
  const owner = { ownerUserId: "o1", email: "owner@example.com", phoneE164: null };
  const row = (messages: unknown[], email = "owner@example.com"): ThreadRow => ({ id: "msg_o1_1", thread_type: "portal_message", owner_user_id: "o1", row_data: { email, messages } });
  it("deletes a thread of only automated turns, keeps one the owner wrote or a person typed", () => {
    expect(isDeletableOwnerThread(row([{ outbound: true, automated: true }, { outbound: true, automated: true }]), owner)).toBe(true);
    expect(isDeletableOwnerThread(row([{ outbound: false, automated: false, body: "can you send my statement?" }]), owner)).toBe(false);
    expect(isDeletableOwnerThread(row([{ outbound: true, automated: true }, { outbound: true, body: "Hi from staff" }]), owner)).toBe(false);
  });
  it("never touches another person's thread or an empty one", () => {
    expect(isDeletableOwnerThread(row([{ outbound: true, automated: true }], "resident@example.com"), owner)).toBe(false);
    expect(isDeletableOwnerThread(row([]), owner)).toBe(false);
  });
});

describe("(d) the 206-line nudge", () => {
  const NUDGE = "PropLane here. Reply anytime to pick up your room search. Reply STOP to opt out.";
  const turn = (id: string, lead: string, direction: string, body: string) => ({ id, lead_id: lead, direction, body });
  it("matches only the nudge text", () => {
    expect(isLeadNudgeBody(NUDGE)).toBe(true);
    expect(isLeadNudgeBody("Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?")).toBe(false);
  });
  it("removes just the nudge when it is the lead's only outbound text, keeping the lead's own messages", () => {
    const plan = planLeadNudgeCleanup([
      turn("1", "L1", "inbound", "hi any rooms?"), turn("2", "L1", "outbound", NUDGE), turn("3", "L1", "outbound", NUDGE),
      // L2 was answered by something else: untouched.
      turn("4", "L2", "inbound", "budget 900"), turn("5", "L2", "outbound", "Room 4 is $850"), turn("6", "L2", "outbound", NUDGE),
      // L3 never got any outbound text: nothing to remove.
      turn("7", "L3", "inbound", "hello"),
    ]);
    expect(plan.remove.map((t) => t.id)).toEqual(["2", "3"]);
    expect(plan.leads).toBe(1);
  });
});

describe("where it may write", () => {
  it("a dry run reads anywhere; apply needs dev or the explicit flag", () => {
    expect(() => assertInboxCleanupWriteAllowed("qahnczmilgptcedaqype", false, {})).not.toThrow();
    expect(() => assertInboxCleanupWriteAllowed("emstjswhotsnyksqhqyf", true, {})).not.toThrow();
    expect(() => assertInboxCleanupWriteAllowed("qahnczmilgptcedaqype", true, {})).toThrow(/PRODUCTION/);
    expect(() => assertInboxCleanupWriteAllowed("xwszcafaontidfgznlxd", true, {})).toThrow(/STAGING/);
    expect(() => assertInboxCleanupWriteAllowed("qahnczmilgptcedaqype", true, { ALLOW_PRODUCTION_INBOX_CLEANUP: "1" })).not.toThrow();
  });
});
