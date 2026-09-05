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
});
