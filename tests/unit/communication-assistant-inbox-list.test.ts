import { describe, expect, it } from "vitest";
import {
  buildResidentAssistantPlaceholderThread,
  communicationInboxListPreview,
  ensureAssistantThreadInRows,
  managerAgentNoticeThreadId,
  pinPropLaneAssistantUnifiedItems,
  propLaneAssistantListSubtitle,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationInboxThread,
  resolveCommunicationViewerId,
  withPinnedPropLaneAssistantThreads,
} from "@/lib/communication-assistant-inbox-list";
import { unifiedInboxKey, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

const RESIDENT = "d1b42a92-0784-4ccc-b857-41db374547e1";
const MANAGER = "552b562f-e9cb-443b-84ec-48018fc0fa19";

describe("communication assistant inbox list", () => {
  it("builds stable thread ids per portal", () => {
    expect(propLaneAssistantThreadIdForPortal("resident", RESIDENT)).toBe(`resident-agent-${RESIDENT}`);
    expect(propLaneAssistantThreadIdForPortal("manager", MANAGER)).toBe(managerAgentNoticeThreadId(MANAGER));
  });

  it("injects a resident placeholder on Active when missing", () => {
    const rows = withPinnedPropLaneAssistantThreads([], "resident", RESIDENT, "active");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(`resident-agent-${RESIDENT}`);
    expect(rows[0]!.from).toBe("PropLane Assistant");
  });

  it("does not duplicate an existing assistant row", () => {
    const existing = buildResidentAssistantPlaceholderThread(RESIDENT);
    const rows = ensureAssistantThreadInRows([existing], buildResidentAssistantPlaceholderThread(RESIDENT));
    expect(rows).toHaveLength(1);
  });

  it("pins the assistant row to the top of unified items", () => {
    const assistantId = `resident-agent-${RESIDENT}`;
    const assistant: UnifiedInboxListItem = {
      key: unifiedInboxKey("email", assistantId),
      channel: "email",
      threadId: assistantId,
      name: "PropLane Assistant",
      preview: "hello",
      time: "",
      unread: false,
      sortMs: 1,
    };
    const other: UnifiedInboxListItem = {
      key: unifiedInboxKey("email", "other-thread"),
      channel: "email",
      threadId: "other-thread",
      name: "Manager",
      preview: "later",
      time: "Today",
      unread: false,
      sortMs: 9_999,
    };
    const pinned = pinPropLaneAssistantUnifiedItems([other, assistant], assistantId);
    expect(pinned[0]!.threadId).toBe(assistantId);
  });

  it("skips placeholder injection on unread and archived segments", () => {
    expect(withPinnedPropLaneAssistantThreads([], "resident", RESIDENT, "unread")).toEqual([]);
    expect(withPinnedPropLaneAssistantThreads([], "resident", RESIDENT, "archived")).toEqual([]);
  });

  it("prefers the server-provided viewer id", () => {
    expect(resolveCommunicationViewerId(RESIDENT, "other-id")).toBe(RESIDENT);
    expect(resolveCommunicationViewerId(null, MANAGER)).toBe(MANAGER);
  });

  it("omits empty archived list previews", () => {
    expect(communicationInboxListPreview("No messages yet.", "archived")).toBe("");
    expect(communicationInboxListPreview("Hello there", "archived")).toBe("Hello there");
    expect(communicationInboxListPreview("No messages yet.", "active")).toBe("No messages yet.");
  });

  it("resolves assistant placeholder when list pins it before persistence", () => {
    const assistantId = `resident-agent-${RESIDENT}`;
    const placeholder = buildResidentAssistantPlaceholderThread(RESIDENT);
    const resolved = resolveCommunicationInboxThread(assistantId, [placeholder], [], "resident", RESIDENT);
    expect(resolved?.id).toBe(assistantId);
    expect(resolved?.from).toBe("PropLane Assistant");
  });

  it("labels assistant rows with the PropLane channel", () => {
    const thread = buildResidentAssistantPlaceholderThread(RESIDENT);
    expect(propLaneAssistantListSubtitle(thread)).toBe("PropLane");
  });
});
