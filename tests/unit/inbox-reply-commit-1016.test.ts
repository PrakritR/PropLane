import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { commitInboxThreadReply, type InboxThreadReplyTarget } from "@/lib/portal-inbox-delivery";

/**
 * QA C2 + C5: the reply the composer shows and the reply the server stores are ONE
 * message (same id, not two ids under two sender names), and a sent reply consumes
 * the AI draft that was pending on the thread.
 */

const MGR = "axis_portal_inbox_manager_v1";

function seed() {
  const db = createMemoryDb({
    portal_inbox_thread_records: [
      {
        id: "t1",
        scope: MGR,
        owner_user_id: "mgr-1",
        participant_email: null,
        row_data: {
          id: "t1",
          folder: "inbox",
          unread: true,
          body: "Is the sink fixed?",
          messages: [],
          aiDraft: { text: "Yes, it is fixed.", status: "pending_approval", generatedAt: "g1" },
        },
      },
    ],
  });
  const target = { threadId: "t1", scope: MGR, ownerUserId: "mgr-1", participantEmail: null } as unknown as InboxThreadReplyTarget;
  return { db: db as never, raw: db, target };
}

const stored = (raw: ReturnType<typeof createMemoryDb>) =>
  (raw.__tables.portal_inbox_thread_records![0]!.row_data as { messages: { id: string; from: string }[]; aiDraft?: unknown });

describe("commitInboxThreadReply", () => {
  it("stores the turn under the id the composer gave it, once, however many channels call it", async () => {
    const { db, raw, target } = seed();
    const opts = { fromName: "Test Manager", text: "It is fixed.", messageId: "reply-abc12" };
    await commitInboxThreadReply(db, target, opts);
    await commitInboxThreadReply(db, target, opts);
    const messages = stored(raw).messages;
    expect(messages.map((m) => m.id)).toEqual(["reply-abc12"]);
  });

  it("removes the pending AI draft the reply answered", async () => {
    const { db, raw, target } = seed();
    await commitInboxThreadReply(db, target, { fromName: "Test Manager", text: "Yes, it is fixed.", messageId: "reply-1" });
    expect(stored(raw).aiDraft).toBeUndefined();
  });
});
