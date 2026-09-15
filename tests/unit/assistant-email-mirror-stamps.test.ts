import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn(async () => ({ sent: 0, skipped: true })),
}));
vi.mock("@/lib/webhooks/deliver.server", () => ({ enqueueWebhookEvent: async () => {} }));

import { mirrorAssistantEmailConversation } from "@/lib/manager-assistant-email/mirror-assistant-email-conversation.server";
import {
  inboxThreadMessages,
  lastInboundChannelOf,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

type StoredRow = Record<string, unknown>;

/**
 * Minimal thread-table fake: replays the eq-chain that
 * `findExistingPortalMessageThread` applies (including the JSON-path
 * folder/email pair) and the id read that `commitInboxThreadReply` does.
 */
function fakeDb() {
  const threads = new Map<string, StoredRow>();
  function table() {
    const filters: Array<[string, unknown]> = [];
    const rows = () =>
      [...threads.values()].filter((row) =>
        filters.every(([column, value]) => {
          const rowData = (row.row_data ?? {}) as StoredRow;
          if (column === "row_data->>folder") return String(rowData.folder ?? "") === value;
          if (column === "row_data->>email") return String(rowData.email ?? "") === value;
          return row[column] === value;
        }),
      );
    const chain = {
      select: () => chain,
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return chain;
      },
      order: () => chain,
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      upsert: async (record: StoredRow) => {
        threads.set(String(record.id), record);
        return { error: null };
      },
    };
    return chain;
  }
  return { threads, from: () => table() };
}

const ARGS = {
  managerUserId: "3f9a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8",
  managerEmail: "ambika@example.com",
  senderEmail: "prakrit@example.com",
  senderName: "Prakrit Ramachandran",
  subject: "Propert",
  inboundText: "Hey I saw your property can I schedule a tour",
  replyText: "Can I help you set up a tour?",
  inboundEmailId: "email-1",
};

function storedThread(db: ReturnType<typeof fakeDb>): PersistedInboxThread {
  const row = [...db.threads.values()][0];
  return (row?.row_data ?? {}) as PersistedInboxThread;
}

describe("assistant email mirror stamps", () => {
  it("stamps the inbound with channel email + subject, and a sent reply with channel email + Re: subject", async () => {
    const db = fakeDb();
    await mirrorAssistantEmailConversation(db as unknown as SupabaseClient, { ...ARGS, replySent: true });

    const thread = storedThread(db);
    expect(thread.rootChannel).toBe("email");
    expect(thread.rootSubject).toBe("Propert");

    const turns = inboxThreadMessages(thread);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ channel: "email", subject: "Propert" });
    expect(turns[1]).toMatchObject({ channel: "email", subject: "Re: Propert", outbound: true });
    expect(lastInboundChannelOf(thread)).toBe("email");
  });

  it("leaves an unsent assistant reply without a channel stamp", async () => {
    const db = fakeDb();
    await mirrorAssistantEmailConversation(db as unknown as SupabaseClient, { ...ARGS, replySent: false });

    const turns = inboxThreadMessages(storedThread(db));
    expect(turns[1]?.channel).toBeUndefined();
    expect(turns[1]?.subject).toBeUndefined();
  });

  it("finds the last inbound channel past the owner's own replies and ignores unstamped rows", () => {
    const withReplies: PersistedInboxThread = {
      id: "t1",
      folder: "inbox",
      from: "Prakrit",
      email: "prakrit@example.com",
      subject: "Propert",
      preview: "",
      body: "hi",
      time: "now",
      unread: false,
      rootChannel: "sms",
      messages: [
        { id: "m1", from: "You", body: "hey", at: "now", channel: "proplane" },
        { id: "m2", from: "Prakrit", body: "a", at: "now", outbound: false, channel: "email" },
        { id: "m3", from: "You", body: "ok", at: "now", channel: "email" },
      ],
    };
    expect(lastInboundChannelOf(withReplies)).toBe("email");

    const legacy: PersistedInboxThread = { ...withReplies, rootChannel: undefined, messages: [] };
    expect(lastInboundChannelOf(legacy)).toBeNull();

    const sentFolder: PersistedInboxThread = { ...withReplies, folder: "sent", messages: [] };
    expect(lastInboundChannelOf(sentFolder)).toBeNull();

    // A merged person-thread keeps the Sent copy's folder but flags the emailed-in root.
    const mergedUnderSentId: PersistedInboxThread = {
      ...withReplies,
      folder: "sent",
      rootOutbound: false,
      rootChannel: "email",
      messages: [{ id: "r", from: "You", body: "hey", at: "now", channel: "email" }],
    };
    expect(lastInboundChannelOf(mergedUnderSentId)).toBe("email");
  });
});
