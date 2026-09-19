import { describe, expect, it } from "vitest";
import {
  mergeUnifiedInboxItems,
  unifiedInboxKey,
} from "@/lib/unified-inbox-merge";
import type { UnifiedInboxListItem } from "@/lib/unified-inbox-merge";

function emailRow(
  id: string,
  options: Partial<UnifiedInboxListItem> = {},
): UnifiedInboxListItem {
  return {
    key: unifiedInboxKey("email", id),
    channel: "email",
    threadId: id,
    name: "Morgan Manager",
    subtitle: "Email",
    preview: `email ${id}`,
    time: "Sep 18, 10:00 AM",
    unread: false,
    sortMs: 10,
    personKey: "manager@example.com",
    memberKeys: [unifiedInboxKey("email", id)],
    ...options,
  };
}

function smsRow(
  conversationKey: string,
  options: Partial<UnifiedInboxListItem> = {},
): UnifiedInboxListItem {
  return {
    key: unifiedInboxKey("sms", conversationKey),
    channel: "sms",
    threadId: conversationKey,
    name: "Morgan Manager",
    subtitle: "Ash Flats",
    preview: `sms ${conversationKey}`,
    time: "Sep 18, 10:01 AM",
    unread: false,
    sortMs: 11,
    personKey: "manager@example.com",
    personEmail: "manager@example.com",
    smsBindingKey: conversationKey,
    memberKeys: [unifiedInboxKey("sms", conversationKey)],
    ...options,
  };
}

describe("conversation identity correction regressions", () => {
  it("keeps the explicitly selected native conversation and isolates another native key", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow("email-b", { smsBindingKey: "manager-b" }),
      smsRow("manager-b", { preview: "B's message", sortMs: 30 }),
      smsRow("manager-a", { preview: "A's message", sortMs: 40 }),
      {
        ...smsRow("unknown", { preview: "Unknown message", sortMs: 50 }),
        personKey: undefined,
        personEmail: undefined,
        smsBindingKey: undefined,
      },
    ]);

    expect(rows).toHaveLength(3);
    const selected = rows.find((row) => row.smsBindingKey === "manager-b");
    expect(selected).toMatchObject({
      channels: ["sms", "email"],
      preview: "B's message",
      smsBindingKeys: ["manager-b"],
    });
    expect(selected?.memberKeys).toEqual([
      unifiedInboxKey("sms", "manager-b"),
      unifiedInboxKey("email", "email-b"),
    ]);
    expect(rows.some((row) => row.threadId === "manager-a")).toBe(true);
    expect(rows.some((row) => row.threadId === "unknown")).toBe(true);
    expect(selected?.memberKeys).not.toContain(unifiedInboxKey("sms", "manager-a"));
    expect(selected?.memberKeys).not.toContain(unifiedInboxKey("sms", "unknown"));
  });

  it("does not guess across conflicting stored email identities", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow("email-a", { personKey: "a@example.com" }),
      smsRow("manager-b", {
        personKey: "b@example.com",
        personEmail: "b@example.com",
        preview: "B's message",
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "email", personKey: "a@example.com" }),
      expect.objectContaining({ channel: "sms", threadId: "manager-b", personKey: "b@example.com" }),
    ]));
  });

  it("retains a verified unread conversation when an isolated unknown history is already read", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow("known", { unread: true, unreadCount: 1 }),
      {
        ...smsRow("unknown", { unread: false, sortMs: 20 }),
        personKey: undefined,
        personEmail: undefined,
        smsBindingKey: undefined,
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.threadId === "known")).toMatchObject({ unread: true, unreadCount: 1 });
    expect(rows.find((row) => row.threadId === "unknown")).toMatchObject({ unread: false });
  });

  it("preserves every selected email source and refuses acknowledgement on conflicting observations", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow("archived-old", {
        sortMs: 10,
        readSources: [{ id: "archived-old", observation: "obs-old", unread: false }],
        readSourcesComplete: true,
      }),
      emailRow("archived-new", {
        sortMs: 20,
        readSources: [{ id: "archived-new", observation: "obs-new", unread: true }],
        readSourcesComplete: true,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberKeys).toEqual([
      unifiedInboxKey("email", "archived-new"),
      unifiedInboxKey("email", "archived-old"),
    ]);
    expect(rows[0]?.readSources).toEqual([
      { id: "archived-new", observation: "obs-new", unread: true },
      { id: "archived-old", observation: "obs-old", unread: false },
    ]);
    expect(rows[0]?.readSourcesComplete).toBe(true);

    const conflicting = mergeUnifiedInboxItems([
      emailRow("same-source", {
        readSources: [{ id: "same-source", observation: "obs-one", unread: true }],
        readSourcesComplete: true,
      }),
      emailRow("same-source-copy", {
        readSources: [{ id: "same-source", observation: "obs-two", unread: false }],
        readSourcesComplete: true,
      }),
    ]);
    expect(conflicting[0]?.readSources).toEqual([]);
    expect(conflicting[0]?.readSourcesComplete).toBe(false);
  });
});
