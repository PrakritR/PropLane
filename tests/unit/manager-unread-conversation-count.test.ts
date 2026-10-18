import { afterEach, describe, expect, it } from "vitest";
import {
  countFoldedUnreadManagerConversations,
  managerUnreadConversationCount,
  publishManagerUnreadConversationCount,
  readPublishedManagerUnreadConversationCount,
  resetPublishedManagerUnreadConversationCount,
  subscribeManagerUnreadConversationCount,
} from "@/lib/manager-unread-conversation-count";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

/**
 * QA C8: the sidebar said 1 while the assistant's attention row said 2. One person with an
 * inbox copy and a notice copy is ONE conversation; every surface shows the sidebar's number.
 */

const row = (id: string, over: Partial<PersistedInboxThread> = {}): PersistedInboxThread => ({
  id,
  folder: "inbox",
  from: "Rae Resident",
  email: "rae@example.test",
  subject: "Hi",
  preview: "",
  body: "Hello",
  time: "Oct 14, 2026, 9:00 AM",
  unread: true,
  ...over,
});

afterEach(() => resetPublishedManagerUnreadConversationCount());

describe("manager unread conversation count", () => {
  it("counts a person's two unread rows as one conversation", () => {
    const rows = [row("a"), row("b", { time: "Oct 14, 2026, 9:05 AM" })];
    expect(rows.filter((r) => r.folder === "inbox" && r.unread)).toHaveLength(2);
    expect(countFoldedUnreadManagerConversations(rows, "mgr-1")).toBe(1);
  });

  it("a different person is a different conversation", () => {
    const rows = [row("a"), row("b", { email: "sam@example.test", from: "Sam" })];
    expect(countFoldedUnreadManagerConversations(rows, "mgr-1")).toBe(2);
  });

  it("shows the number the sidebar published, for the same viewer and workspace only", () => {
    const rows = [row("a"), row("b", { email: "sam@example.test", from: "Sam" })];
    expect(managerUnreadConversationCount("mgr-1:w1", rows, "mgr-1")).toBe(2);
    publishManagerUnreadConversationCount("mgr-1:w1", 5);
    expect(managerUnreadConversationCount("mgr-1:w1", rows, "mgr-1")).toBe(5);
    expect(readPublishedManagerUnreadConversationCount("mgr-1:w2")).toBeNull();
    expect(managerUnreadConversationCount("mgr-1:w2", rows, "mgr-1")).toBe(2);
  });

  it("tells subscribers when the number changes, and only then", () => {
    let calls = 0;
    const stop = subscribeManagerUnreadConversationCount(() => {
      calls += 1;
    });
    publishManagerUnreadConversationCount("mgr-1:", 1);
    publishManagerUnreadConversationCount("mgr-1:", 1);
    publishManagerUnreadConversationCount("mgr-1:", 2);
    stop();
    publishManagerUnreadConversationCount("mgr-1:", 3);
    expect(calls).toBe(2);
  });
});
