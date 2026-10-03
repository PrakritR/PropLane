import { describe, expect, it } from "vitest";
import {
  inboxThreadLastTurnDirection,
  inboxTurnDirection,
  inboxTurnIsOutbound,
  isConversationWithPropLaneAssistant,
} from "@/lib/inbox-turn-direction";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

function thread(
  overrides: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id">,
): PersistedInboxThread {
  return {
    folder: "inbox",
    from: "Someone",
    email: "someone@example.com",
    subject: "Hi",
    preview: "Hi",
    body: "Hi",
    time: "Sep 3, 1:00 PM",
    unread: false,
    ...overrides,
  };
}

describe("inbox turn direction", () => {
  it("marks PropLane Assistant turns as ice, not as You", () => {
    const conversation = thread({
      id: "resident-agent-1",
      from: "PropLane Assistant",
      email: "",
      folder: "inbox",
      body: "",
      threadType: "resident_agent",
      messages: [
        {
          id: "intro",
          from: "PropLane Assistant",
          body: "Hi - you can ask me about your lease.",
          at: "1",
        },
        {
          id: "ask",
          from: "Jordan",
          body: "What is my rent?",
          at: "2",
        },
        {
          id: "answer",
          from: "PropLane Assistant",
          body: "Your rent is due on the 1st.",
          at: "3",
        },
      ],
    });
    expect(isConversationWithPropLaneAssistant(conversation)).toBe(true);
    expect(inboxTurnDirection(conversation, conversation.messages![0]!, 1, "inbox")).toBe("assistant");
    expect(inboxTurnIsOutbound(conversation, conversation.messages![0]!, 1, "inbox")).toBe(false);
    expect(inboxTurnDirection(conversation, conversation.messages![1]!, 2, "inbox")).toBe("outbound");
    expect(inboxTurnIsOutbound(conversation, conversation.messages![1]!, 2, "inbox")).toBe(true);
    expect(inboxTurnDirection(conversation, conversation.messages![2]!, 3, "inbox")).toBe("assistant");
    expect(inboxThreadLastTurnDirection(conversation)).toBe("assistant");
  });

  it("treats a payment reminder authored as PropLane Assistant as ice, not You", () => {
    const reminder = thread({
      id: "payment_sent_1",
      folder: "sent",
      from: "PropLane Assistant",
      email: "resident@example.com",
      body: "Your rent is overdue.",
      rootOutbound: true,
    });
    const turn = {
      id: "root",
      from: "PropLane Assistant",
      body: reminder.body,
      at: reminder.time,
      outbound: true,
    };
    expect(isConversationWithPropLaneAssistant(reminder)).toBe(false);
    expect(inboxTurnDirection(reminder, turn, 0, "sent")).toBe("assistant");
    expect(inboxTurnIsOutbound(reminder, turn, 0, "sent")).toBe(false);
    expect(inboxThreadLastTurnDirection(reminder)).toBe("assistant");
  });

  it("keeps a normal person-thread: inbound left, viewer cobalt", () => {
    const person = thread({
      id: "person-1",
      from: "Akhil",
      email: "akhil@example.com",
      folder: "inbox",
      body: "Hello this is akhil",
      messages: [
        {
          id: "reply",
          from: "You",
          body: "Checking that for you now.",
          at: "2",
          outbound: true,
        },
      ],
    });
    const root = { id: "root", from: "Akhil", body: person.body, at: person.time, outbound: false };
    expect(inboxTurnDirection(person, root, 0, "inbox")).toBe("inbound");
    expect(inboxTurnDirection(person, person.messages![0]!, 1, "inbox")).toBe("outbound");
    expect(inboxThreadLastTurnDirection(person)).toBe("outbound");
  });

  it("marks an auto-sent lifecycle turn as a system notice, never You", () => {
    const person = thread({
      id: "person-2",
      from: "Akhil",
      email: "akhil@example.com",
      folder: "sent",
      body: "Your lease is ready to sign.",
      messages: [
        {
          id: "reply",
          from: "Akhil",
          body: "Let me know if you have questions.",
          at: "2",
          outbound: true,
        },
      ],
    });
    const automatedRoot = {
      id: "root",
      from: "Akhil",
      body: person.body,
      at: person.time,
      automated: true,
    };
    expect(inboxTurnDirection(person, automatedRoot, 0, "sent")).toBe("system");
    expect(inboxTurnIsOutbound(person, automatedRoot, 0, "sent")).toBe(false);
    // A human-typed reply right after it stays an ordinary outbound bubble.
    expect(inboxTurnDirection(person, person.messages![0]!, 1, "sent")).toBe("outbound");
  });

  it("renders legacy manager agent_notice paragraphs as system events", () => {
    const notice = thread({
      id: "agent_notice_fee",
      from: "PropLane Assistant",
      email: "",
      folder: "inbox",
      threadType: "agent_notice",
      body: "Application fee created.",
      messages: [
        {
          id: "legacy",
          from: "PropLane Assistant",
          body: "When: Aug 3\nWith: 5257 Brooklyn\nDetails: The $50 charge\nView it here: https://example.com",
          at: "2026-08-03T17:31:00-07:00",
        },
      ],
    });
    const turn = notice.messages![0]!;
    expect(inboxTurnDirection(notice, turn, 0, "inbox")).toBe("system");
    expect(inboxTurnIsOutbound(notice, turn, 0, "inbox")).toBe(false);
  });
});
