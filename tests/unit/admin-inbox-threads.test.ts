/**
 * Admin's inbox messages become unified-inbox conversations.
 *
 * The admin page mounts the manager's list over these rows, so the mapping has
 * to keep what the old admin table knew: who a conversation is with, which side
 * wrote each turn, whether it is unread, and which folder it is in (archive
 * survives - a trashed message is an Archived conversation that restores to the
 * folder it came from). The stamps are the canonical inbox stamp
 * (`formatInboxStamp`), the label and the sort key at once.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_REPLY_AUTHOR_LABEL,
  ADMIN_SCHEDULED_STUB_PREFIX,
  adminInboxMessageToThread,
  adminThreadBubbles,
  adminThreadsFrom,
  isAdminScheduledStubId,
} from "@/lib/admin-inbox-threads";

import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";
import {
  formatInboxStamp,
  inboxMessageOutbound,
  inboxThreadMessages,
  inboxThreadSortMs,
} from "@/lib/portal-inbox-storage";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

function msg(overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "folder">): InboxMessage {
  return {
    name: "Jamie Rivera",
    email: "jamie@example.test",
    topic: "Question",
    body: "Root body",
    createdAt: "2026-10-01T17:00:00.000Z",
    read: true,
    senderRole: "manager",
    thread: [],
    ...overrides,
  };
}

function scheduled(overrides: Partial<ScheduledInboxMessageRecord> = {}): ScheduledInboxMessageRecord {
  return {
    id: "sch-1",
    managerUserId: "admin-1",
    sendAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    status: "scheduled",
    subject: "Heads up",
    body: "Later",
    recipientEmail: "New.Person@Example.test",
    recipientName: "New Person",
    deliverViaEmail: false,
    deliverViaSms: false,
    deliverViaInbox: true,
    createdAt: "2026-10-02T17:00:00.000Z",
    ...overrides,
  };
}

describe("adminInboxMessageToThread", () => {
  it("keeps the id, subject, folder and the canonical stamp", () => {
    const thread = adminInboxMessageToThread(msg({ id: "m1", folder: "inbox", read: false }));
    expect(thread).toMatchObject({
      id: "m1",
      folder: "inbox",
      from: "Jamie Rivera",
      email: "jamie@example.test",
      subject: "Question",
      unread: true,
      time: formatInboxStamp(new Date("2026-10-01T17:00:00.000Z")),
    });
    expect(inboxThreadSortMs(thread.id, thread.time)).toBeGreaterThan(0);
  });

  it("only an unread INBOX message is unread", () => {
    expect(adminInboxMessageToThread(msg({ id: "a", folder: "sent", read: false })).unread).toBe(false);
    expect(adminInboxMessageToThread(msg({ id: "b", folder: "trash", read: false })).unread).toBe(false);
    expect(adminInboxMessageToThread(msg({ id: "c", folder: "inbox", read: true })).unread).toBe(false);
  });

  it("a sent message is admin's outbound root; an inbox message is the counterparty's inbound root", () => {
    const sent = adminInboxMessageToThread(msg({ id: "s", folder: "sent" }));
    const inbox = adminInboxMessageToThread(msg({ id: "i", folder: "inbox" }));
    expect(inboxMessageOutbound(inboxThreadMessages(sent)[0]!, 0, sent.folder, sent)).toBe(true);
    expect(inboxMessageOutbound(inboxThreadMessages(inbox)[0]!, 0, inbox.folder, inbox)).toBe(false);
  });

  it("a reply authored by admin's reply label is outbound; any other author is inbound", () => {
    const thread = adminInboxMessageToThread(
      msg({
        id: "t",
        folder: "inbox",
        thread: [
          { id: "r1", authorLabel: ADMIN_REPLY_AUTHOR_LABEL, body: "Our reply", createdAt: "2026-10-02T17:00:00.000Z" },
          { id: "r2", authorLabel: "Jamie Rivera", body: "Follow-up", createdAt: "2026-10-03T17:00:00.000Z" },
        ],
      }),
    );
    const bubbles = adminThreadBubbles([thread]);
    expect(bubbles.map((b) => [b.body, b.direction])).toEqual([
      ["Root body", "inbound"],
      ["Our reply", "outbound"],
      ["Follow-up", "inbound"],
    ]);
  });

  it("archive survives: a trashed message keeps the folder it restores to", () => {
    const fromInbox = adminInboxMessageToThread(msg({ id: "x", folder: "trash", trashedFrom: "inbox" }));
    const fromSent = adminInboxMessageToThread(msg({ id: "y", folder: "trash", trashedFrom: "sent" }));
    expect(fromInbox).toMatchObject({ folder: "trash", previousFolder: "inbox" });
    expect(fromSent).toMatchObject({ folder: "trash", previousFolder: "sent" });
    // A trashed message that admin sent is still admin's outbound root.
    expect(inboxMessageOutbound(inboxThreadMessages(fromSent)[0]!, 0, fromSent.folder, fromSent)).toBe(true);
  });

  it("a broadcast or multi-recipient send is not with one address", () => {
    const broadcast = adminInboxMessageToThread(
      msg({
        id: "b",
        folder: "sent",
        email: "all-managers@axis.local",
        composeAudience: "all_managers",
        composeRecipientLabel: "All managers",
      }),
    );
    expect(broadcast).toMatchObject({ from: "All managers", email: "" });
    const multi = adminInboxMessageToThread(
      msg({ id: "m", folder: "sent", email: "a@x.test; b@x.test", composeAudience: "multi", composeRecipientLabel: "2 managers" }),
    );
    expect(multi.email).toBe("");
  });

  it("a single-recipient send names the recipient and keeps their address", () => {
    const thread = adminInboxMessageToThread(
      msg({
        id: "one",
        folder: "sent",
        composeAudience: "manager",
        composeRecipientLabel: "Jamie Rivera (Manager)",
      }),
    );
    expect(thread).toMatchObject({ from: "Jamie Rivera (Manager)", email: "jamie@example.test" });
  });
});

describe("adminThreadsFrom", () => {
  it("draws a conversation for a scheduled send to someone admin has never messaged", () => {
    const threads = adminThreadsFrom([msg({ id: "m1", folder: "inbox" })], [scheduled()]);
    const stub = threads.find((t) => isAdminScheduledStubId(t.id));
    expect(stub).toMatchObject({
      id: `${ADMIN_SCHEDULED_STUB_PREFIX}new.person@example.test`,
      folder: "sent",
      from: "New Person",
      email: "new.person@example.test",
    });
  });

  it("draws none when a stored conversation is already with that address", () => {
    const threads = adminThreadsFrom(
      [msg({ id: "m1", folder: "inbox", email: "NEW.person@example.test" })],
      [scheduled()],
    );
    expect(threads.some((t) => isAdminScheduledStubId(t.id))).toBe(false);
  });

  it("an ARCHIVED conversation does not hide the scheduled send's own conversation", () => {
    const threads = adminThreadsFrom(
      [msg({ id: "m1", folder: "trash", trashedFrom: "inbox", email: "new.person@example.test" })],
      [scheduled()],
    );
    expect(threads.filter((t) => isAdminScheduledStubId(t.id))).toHaveLength(1);
  });

  it("ignores cancelled and already-sent scheduled messages", () => {
    const threads = adminThreadsFrom(
      [],
      [scheduled({ status: "cancelled" }), scheduled({ id: "s2", status: "sent", recipientEmail: "b@x.test" })],
    );
    expect(threads).toEqual([]);
  });

  it("draws one conversation per address however many sends are pending", () => {
    const threads = adminThreadsFrom([], [scheduled(), scheduled({ id: "sch-2", subject: "Another" })]);
    expect(threads).toHaveLength(1);
  });
});
