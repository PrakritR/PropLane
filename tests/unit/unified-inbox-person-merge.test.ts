/**
 * One person, one conversation.
 *
 * Communication mounts an email list and an SMS list side by side. Nothing used
 * to say that a resident's address and their phone were the same human, so they
 * occupied two rows — and the manager's screenshot showed the same person twice,
 * once with their email and once with their name. Rows now merge on a resolved
 * person key; rows without one never merge, because guessing an unknown number
 * onto a resident would put a stranger's messages, and the replies, in front of
 * the wrong person.
 */
import { describe, expect, it } from "vitest";
import {
  mergeUnifiedInboxItems,
  unifiedInboxKey,
  unifiedInboxPersonKey,
  unifiedInboxSmsBindingKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import { collapsePersonInboxThreads } from "@/lib/portal-inbox-storage";

function emailRow(over: Partial<UnifiedInboxListItem> = {}): UnifiedInboxListItem {
  return {
    key: unifiedInboxKey("email", "thread-1"),
    channel: "email",
    threadId: "thread-1",
    personKey: "dana@example.com",
    personEmail: "dana@example.com",
    name: "dana@example.com",
    preview: "About the lease",
    time: "Sep 1, 2:15 PM",
    unread: false,
    sortMs: 1_000,
    ...over,
  };
}

function smsRow(over: Partial<UnifiedInboxListItem> = {}): UnifiedInboxListItem {
  return {
    key: unifiedInboxKey("sms", "mgr:resident:+12065550100"),
    channel: "sms",
    threadId: "mgr:resident:+12065550100",
    personKey: "dana@example.com",
    personEmail: "dana@example.com",
    name: "Dana Rivera",
    preview: "No messages yet",
    time: "",
    unread: false,
    sortMs: 0,
    ...over,
  };
}

describe("unified inbox person merge", () => {
  it("retains one exact SMS binding when older and newer portal rows collapse", () => {
    const rows = collapsePersonInboxThreads([
      { id: "tour", folder: "inbox", from: "Dana", email: "dana@example.com", subject: "Tour", preview: "Tour", body: "Tour", time: "Sep 1, 2:00 PM", unread: true, smsConversationKey: "mgr:prospect:+12065550100" },
      { id: "later", folder: "inbox", from: "Dana", email: "dana@example.com", subject: "Later", preview: "Later", body: "Later", time: "Sep 1, 3:00 PM", unread: false },
    ], { mergeFolders: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.smsConversationKey).toBe("mgr:prospect:+12065550100");
  });
  it("folds a portal notice only into its exact server-verified SMS conversation", () => {
    const exact = unifiedInboxSmsBindingKey("manager-1:prospect:+12065550100")!;
    const otherRole = unifiedInboxSmsBindingKey("manager-1:resident:+12065550100")!;
    const rows = mergeUnifiedInboxItems([
      emailRow({ personKey: exact, preview: "Tour moved", sortMs: 3 }),
      smsRow({ personKey: exact, preview: "Earlier text", sortMs: 2 }),
      smsRow({ key: "sms:resident-role", threadId: "resident-role", personKey: otherRole, sortMs: 1 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.personKey === exact)).toMatchObject({ preview: "Tour moved", channels: ["email", "sms"] });
    expect(rows.find((row) => row.personKey === otherRole)?.memberKeys).toBeUndefined();
  });

  it("retains the outbound preview direction when an SMS fixture is the newest turn", () => {
    const exact = unifiedInboxSmsBindingKey("manager-1:prospect:+12065550100")!;
    const rows = mergeUnifiedInboxItems([
      emailRow({ personKey: exact, preview: "Tour request", sortMs: 2 }),
      smsRow({ personKey: exact, preview: "Your tour is confirmed", previewPrefix: "You: ", sortMs: 3 }),
    ]);
    expect(rows).toEqual([expect.objectContaining({
      channel: "sms", preview: "Your tour is confirmed", previewPrefix: "You: ", channels: ["sms", "email"],
    })]);
  });
  it("collapses a resident's email and SMS rows into one conversation", () => {
    const rows = mergeUnifiedInboxItems([emailRow(), smsRow()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channels).toEqual(["email", "sms"]);
    expect(rows[0]!.memberKeys).toEqual([
      "email:thread-1",
      "sms:mgr:resident:+12065550100",
    ]);
  });

  it("shows the newest channel's message but keeps the person's real name", () => {
    // The email row is newer, yet only the SMS side knows who they are — a row
    // labelled with an address the manager can already see is a worse label.
    const rows = mergeUnifiedInboxItems([emailRow(), smsRow()]);
    expect(rows[0]!.preview).toBe("About the lease");
    expect(rows[0]!.name).toBe("Dana Rivera");
  });

  it("lets a newer text take over the row's preview and sort position", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow({ sortMs: 1_000 }),
      smsRow({ preview: "Running late on rent", sortMs: 9_000, time: "3:40 PM" }),
    ]);
    expect(rows[0]!.preview).toBe("Running late on rent");
    expect(rows[0]!.time).toBe("3:40 PM");
    expect(rows[0]!.threadId).toBe("mgr:resident:+12065550100");
  });

  it("keeps the merged row unread when EITHER channel is unread", () => {
    const rows = mergeUnifiedInboxItems([emailRow({ unread: false }), smsRow({ unread: true })]);
    expect(rows[0]!.unread).toBe(true);
  });

  it("never merges an unknown number into a resident", () => {
    // No resolved address on the SMS side => no person key => its own row.
    const rows = mergeUnifiedInboxItems([
      emailRow(),
      smsRow({ personKey: undefined, personEmail: undefined, name: "+1 (206) 555-0199" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.name)).toContain("+1 (206) 555-0199");
  });

  it("keeps two different people apart", () => {
    const rows = mergeUnifiedInboxItems([
      emailRow(),
      smsRow({ personKey: "sam@example.com", personEmail: "sam@example.com", name: "Sam Okafor" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("only treats a real address as an identity", () => {
    expect(unifiedInboxPersonKey("  Dana@Example.com ")).toBe("dana@example.com");
    expect(unifiedInboxPersonKey("not-an-email")).toBeUndefined();
    expect(unifiedInboxPersonKey("")).toBeUndefined();
    expect(unifiedInboxPersonKey(null)).toBeUndefined();
  });

  it("sorts merged rows by their newest contributing message", () => {
    const other: UnifiedInboxListItem = {
      key: unifiedInboxKey("email", "thread-2"),
      channel: "email",
      threadId: "thread-2",
      personKey: "sam@example.com",
      name: "Sam Okafor",
      preview: "Older",
      time: "Aug 30, 9:00 AM",
      unread: false,
      sortMs: 5_000,
    };
    const rows = mergeUnifiedInboxItems([
      emailRow({ sortMs: 1_000 }),
      smsRow({ sortMs: 9_000 }),
      other,
    ]);
    expect(rows.map((row) => row.personKey)).toEqual(["dana@example.com", "sam@example.com"]);
  });
});
