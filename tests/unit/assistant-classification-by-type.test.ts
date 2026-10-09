import { describe, expect, it } from "vitest";
import {
  assistantInboxCollapseKey,
  isPropLaneAssistantInboxThread,
} from "@/lib/communication-inbox-assistant";
import { collapseAssistantInboxThreads, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { isResidentAssistantRow } from "@/lib/communication/resident-conversation";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import { SMS_AUTO_REPLY_AUTHOR } from "@/lib/sms-inbox-notice.server";
import { TEAM_THREAD_DISPLAY_NAME, teamThreadDisplayName } from "@/lib/team-thread-display";

function row(overrides: Partial<PersistedInboxThread> & Record<string, unknown>): PersistedInboxThread {
  return {
    id: "x",
    folder: "inbox",
    from: "",
    email: "",
    subject: "",
    preview: "",
    time: "Oct 9, 9:00 AM",
    unread: false,
    ...overrides,
  } as PersistedInboxThread;
}

describe("the Assistant is decided by the row's type or id, never by a name", () => {
  const prospectSms = row({
    id: "sms_notice_abc",
    from: "PropLane Assistant",
    threadType: "claw_leasing_sms",
    smsNoticePhone: "+15105550100",
    messages: [{ id: "m1", from: "PropLane Assistant", body: "Hi!", at: "Oct 9, 9:00 AM", outbound: false }],
  });

  it("an SMS prospect thread whose last turn is named PropLane Assistant is not the Assistant", () => {
    expect(isPropLaneAssistantInboxThread(prospectSms)).toBe(false);
    expect(assistantInboxCollapseKey(prospectSms)).toBeNull();
    expect(isResidentAssistantRow(prospectSms)).toBe(false);
  });

  it("it stays out of the Assistant collapse", () => {
    const real = row({ id: "agent_notice_u1", threadType: "agent_notice", from: "PropLane Assistant" });
    const collapsed = collapseAssistantInboxThreads([real, prospectSms]);
    expect(collapsed.map((t) => t.id).sort()).toEqual(["agent_notice_u1", "sms_notice_abc"]);
  });

  it("the real Assistant rows are still recognized by type and by id", () => {
    expect(isPropLaneAssistantInboxThread(row({ id: "agent_notice_u1", threadType: "agent_notice" }))).toBe(true);
    expect(isPropLaneAssistantInboxThread(row({ id: "agent_notice_u1__ws" }))).toBe(true);
    expect(isPropLaneAssistantInboxThread(row({ id: "resident-agent-u1", threadType: "resident_agent" }))).toBe(true);
    expect(assistantInboxCollapseKey(row({ id: "agent_notice_u1__ws", threadType: "agent_notice" }))).toBe("agent_notice:u1:ws");
  });

  it("a person thread named PropLane Assistant by its sender is a person thread", () => {
    expect(isPropLaneAssistantInboxThread(row({ id: "msg_1", from: "PropLane Assistant", email: "a@b.co" }))).toBe(false);
  });
});

describe("an SMS auto-reply previews as a sent turn", () => {
  it("is authored 'You · Assistant' and reads outbound, not as the Assistant's own bubble", () => {
    expect(SMS_AUTO_REPLY_AUTHOR).not.toBe("PropLane Assistant");
    const thread = row({
      id: "sms_notice_abc",
      from: "+15105550100",
      threadType: "claw_leasing_sms",
      messages: [
        { id: "in", from: "+15105550100", body: "Is it open?", at: "Oct 9, 9:00 AM", outbound: false, channel: "sms" },
        { id: "out", from: SMS_AUTO_REPLY_AUTHOR, body: "Yes!", at: "Oct 9, 9:01 AM", outbound: true, channel: "sms" },
      ],
    });
    expect(inboxThreadLastTurnDirection(thread)).toBe("outbound");
  });
});

describe("a Team thread is never named after a person", () => {
  it("has a fixed display name", () => {
    expect(TEAM_THREAD_DISPLAY_NAME).toBe("Team");
    expect(teamThreadDisplayName()).toBe("Team");
    expect(teamThreadDisplayName("Maple Co")).toBe("Team · Maple Co");
  });
});
