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

  it("restores an archived assistant so Active does not go empty", () => {
    const archived = { ...buildResidentAssistantPlaceholderThread(RESIDENT), folder: "trash" as const };
    const next = ensureAssistantThreadInRows([archived], buildResidentAssistantPlaceholderThread(RESIDENT));
    expect(next).toHaveLength(1);
    expect(next[0]!.folder).toBe("inbox");
    expect(withPinnedPropLaneAssistantThreads([archived], "resident", RESIDENT, "active")).toHaveLength(1);
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

  it("pins the manager assistant on every segment, keyed by workspace", () => {
    const workspace = { id: "ws-brooklyn", isDefault: false };
    const id = managerAgentNoticeThreadId(MANAGER, workspace);
    for (const segment of ["active", "unread", "archived"] as const) {
      const rows = withPinnedPropLaneAssistantThreads([], "manager", MANAGER, segment, workspace);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
      expect(rows[0]!.folder).toBe("inbox");
    }
  });

  it("pins the manager assistant on the legacy id before a workspace identity loads", () => {
    const rows = withPinnedPropLaneAssistantThreads([], "manager", MANAGER, "active");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(managerAgentNoticeThreadId(MANAGER));
  });

  it("keeps a default-workspace manager assistant on the legacy thread id", () => {
    const workspace = { id: "ws-default", isDefault: true };
    const rows = withPinnedPropLaneAssistantThreads([], "manager", MANAGER, "active", workspace);
    expect(rows[0]!.id).toBe(managerAgentNoticeThreadId(MANAGER));
  });

  it("hides leftover workspace assistant chats so they cannot badge Communication", () => {
    const workspace = { id: "ws-brooklyn", isDefault: false };
    const leftover: Parameters<typeof withPinnedPropLaneAssistantThreads>[0][number] = {
      id: managerAgentNoticeThreadId(MANAGER),
      folder: "inbox",
      from: "PropLane Assistant",
      email: "",
      subject: "PropLane Assistant",
      preview: "Old workspace",
      body: "Old workspace",
      time: "",
      unread: true,
      threadType: "agent_notice",
    };
    const liveId = managerAgentNoticeThreadId(MANAGER, workspace);
    const live = { ...leftover, id: liveId, unread: false, body: "Seen", preview: "Seen" };
    const rows = withPinnedPropLaneAssistantThreads([leftover, live], "manager", MANAGER, "active", workspace);
    expect(rows.map((row) => row.id)).toEqual([liveId]);
  });

  it("does not treat a longer user id as this viewer's leftover assistant", () => {
    const other = {
      id: `agent_notice_${MANAGER}0`,
      folder: "inbox" as const,
      from: "PropLane Assistant",
      email: "",
      subject: "PropLane Assistant",
      preview: "Other manager",
      body: "Other manager",
      time: "",
      unread: true,
      threadType: "agent_notice" as const,
    };
    const rows = withPinnedPropLaneAssistantThreads([other], "manager", MANAGER, "active");
    expect(rows.map((row) => row.id)).toContain(other.id);
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
