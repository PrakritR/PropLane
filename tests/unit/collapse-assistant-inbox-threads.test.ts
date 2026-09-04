import { describe, expect, it } from "vitest";
import { RESIDENT_AGENT_THREAD_TYPE } from "@/lib/agent/resident-inbox-agent.server";
import { canonicalResidentAgentThreadId } from "@/lib/communication-inbox-assistant";
import {
  collapseAssistantInboxThreads,
  inboxMessageOutbound,
  inboxThreadMessages,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

const RESIDENT = "d1b42a92-0784-4ccc-b857-41db374547e1";
const MANAGER_A = "552b562f-e9cb-443b-84ec-48018fc0fa19";
const MANAGER_B = "662c6730-f0dc-554c-95fd-59129fc1fb20";

function assistantThread(id: string, managerUserId: string): PersistedInboxThread {
  return {
    id,
    folder: "inbox",
    from: "PropLane Assistant",
    email: "",
    subject: "Ask PropLane",
    preview: "Ask about your lease",
    body: "Hi",
    time: "Aug 3, 5:31 PM",
    unread: false,
    threadType: RESIDENT_AGENT_THREAD_TYPE,
    boundManagerUserId: managerUserId,
  };
}

describe("collapseAssistantInboxThreads", () => {
  it("merges legacy per-manager assistant threads into one canonical row", () => {
    const legacyA = assistantThread(`resident-agent-${RESIDENT}-${MANAGER_A}`, MANAGER_A);
    const legacyB = assistantThread(`resident-agent-${RESIDENT}-${MANAGER_B}`, MANAGER_B);
  legacyB.time = "Aug 4, 5:31 PM";

    const collapsed = collapseAssistantInboxThreads([legacyA, legacyB]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe(canonicalResidentAgentThreadId(RESIDENT));
  });

  it("leaves human conversations untouched", () => {
    const human: PersistedInboxThread = {
      id: "portal-message-1",
      folder: "inbox",
      from: "Alex Resident",
      email: "alex@example.com",
      subject: "Rent question",
      preview: "When is rent due?",
      body: "When is rent due?",
      time: "Aug 3, 5:31 PM",
      unread: true,
    };
    const collapsed = collapseAssistantInboxThreads([human]);
    expect(collapsed).toEqual([human]);
  });

  it("renders PropLane Assistant intro turns as inbound, not manager outbound", () => {
    const thread: PersistedInboxThread = {
      id: `agent_notice_${MANAGER_A}`,
      folder: "inbox",
      from: "PropLane Assistant",
      email: "",
      subject: "PropLane Assistant",
      preview: "Hi",
      body: "Hi — I am PropLane Assistant.",
      time: "Aug 3, 5:31 PM",
      unread: false,
      threadType: "agent_notice",
      messages: [
        {
          id: "manager-agent-intro",
          from: "PropLane Assistant",
          body: "Hi — I am PropLane Assistant.",
          at: "Aug 3, 5:31 PM",
        },
      ],
    };
    const turns = inboxThreadMessages(thread);
    expect(turns).toHaveLength(1);
    expect(inboxMessageOutbound(turns[0]!, 0, thread.folder, thread)).toBe(false);
  });
});
