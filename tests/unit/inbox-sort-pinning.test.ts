import { describe, expect, it } from "vitest";
import { groupWorkspaceChatsAfterAssistant } from "@/lib/communication-assistant-inbox-list";
import { parseInboxStampMs } from "@/lib/portal-inbox-storage";
import { mergeUnifiedInboxItems, unifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import { orderResidentConversationRows } from "@/lib/communication/resident-conversation-names";

const NOW = new Date("2026-11-12T12:00:00-08:00");
const ASSISTANT = "agent_notice_mgr-1";
const TEAM = "team-thread:owner-1:ws:ws-1";

function row(threadId: string, name: string, stamp: string, personKey?: string): UnifiedInboxListItem {
  return {
    key: unifiedInboxKey("email", threadId),
    channel: "email",
    threadId,
    name,
    preview: "",
    time: stamp,
    unread: false,
    sortMs: parseInboxStampMs(stamp, NOW) ?? 0,
    ...(personKey ? { personKey } : {}),
  };
}

// The captain's Nov 12 screenshot of Admin > "1. Ambika" Communication, Active, in the order it was drawn.
const screenshot = [
  row(ASSISTANT, "PropLane Assistant", "Nov 12, 1:00 AM"),
  row(TEAM, "Team · 1. Ambika", "Nov 12, 1:21 AM"),
  row("house-thread:owner-1:ws:ws-1:prop:a", "House · 4709a 8th Ave", "Nov 4, 9:00 AM"),
  row("house-thread:owner-1:ws:ws-1:prop:b", "House · 5259 Brooklyn Ave", "Oct 24, 5:00 PM"),
  row("house-thread:owner-1:ws:ws-1:prop:c", "House · 5257 Brooklyn Ave", "Oct 24, 4:00 PM"),
  row("t-kumaran", "Kumaran Chanthrakumar", "Nov 3, 10:00 AM", "kumaran@example.com"),
  row("t-ambika", "Ambika Mago", "Nov 2, 10:00 AM", "ambika@example.com"),
  row("t-510", "+1 (510) 648-9423", "Oct 16, 3:00 PM", "tel:+15106489423"),
  row("t-425", "+1 (425) 555-0100", "Oct 11, 3:00 PM", "tel:+14255550100"),
];

describe("Communication list order: pin only the Assistant and the Team chat", () => {
  it("the screenshot's rows come out Assistant, Team, then strictly by last activity (house chats included)", () => {
    const merged = mergeUnifiedInboxItems(screenshot, "recent");
    const ordered = groupWorkspaceChatsAfterAssistant(merged, ASSISTANT).map((item) => item.name);
    expect(ordered).toEqual([
      "PropLane Assistant",
      "Team · 1. Ambika",
      "House · 4709a 8th Ave", // Nov 4
      "Kumaran Chanthrakumar", // Nov 3
      "Ambika Mago", // Nov 2
      "House · 5259 Brooklyn Ave", // Oct 24, later in the day
      "House · 5257 Brooklyn Ave", // Oct 24
      "+1 (510) 648-9423", // Oct 16
      "+1 (425) 555-0100", // Oct 11
    ]);
  });

  it("sorts on the real timestamp, not the label: 'Nov 4' outranks 'Oct 24' and a December stamp read in January is last year's", () => {
    expect(parseInboxStampMs("Nov 4, 9:00 AM", NOW)!).toBeGreaterThan(parseInboxStampMs("Oct 24, 5:00 PM", NOW)!);
    const january = new Date("2027-01-05T12:00:00-08:00");
    expect(parseInboxStampMs("Dec 30, 9:00 AM", january)!).toBeLessThan(january.getTime());
  });

  it("a house chat is never hoisted above a newer person conversation", () => {
    const merged = mergeUnifiedInboxItems(screenshot, "recent");
    const names = groupWorkspaceChatsAfterAssistant(merged, ASSISTANT).map((item) => item.name);
    expect(names.indexOf("Kumaran Chanthrakumar")).toBeLessThan(names.indexOf("House · 5259 Brooklyn Ave"));
  });

  it("with no Team chat the list is untouched (the Assistant pin is a separate step)", () => {
    const noTeam = screenshot.filter((item) => item.threadId !== TEAM);
    const merged = mergeUnifiedInboxItems(noTeam, "recent");
    expect(groupWorkspaceChatsAfterAssistant(merged, ASSISTANT)).toEqual(merged);
  });

  it("an older Team chat still sits right under the Assistant", () => {
    const old = screenshot.map((item) => (item.threadId === TEAM ? { ...item, sortMs: 1 } : item));
    const names = groupWorkspaceChatsAfterAssistant(mergeUnifiedInboxItems(old, "recent"), ASSISTANT).map((item) => item.name);
    expect(names.slice(0, 2)).toEqual(["PropLane Assistant", "Team · 1. Ambika"]);
  });
});

describe("resident Communication: only the PropLane agent is pinned", () => {
  it("house chats sort among the other conversations by last activity", () => {
    const rows = [
      { threadId: "chat", sortMs: parseInboxStampMs("Oct 24, 5:00 PM", NOW)!, kind: "house_chat" as const },
      { threadId: "mgr", sortMs: parseInboxStampMs("Nov 3, 10:00 AM", NOW)!, kind: "house" as const },
      { threadId: "agent", sortMs: 1, kind: "proplane_agent" as const },
      { threadId: "chat2", sortMs: parseInboxStampMs("Nov 4, 10:00 AM", NOW)!, kind: "house_chat" as const },
    ];
    expect(orderResidentConversationRows(rows, (r) => r.kind).map((r) => r.threadId)).toEqual(["agent", "chat2", "mgr", "chat"]);
  });
});
