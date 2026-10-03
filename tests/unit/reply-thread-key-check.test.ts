import { beforeEach, describe, expect, it } from "vitest";
import { replyRecipientsMatchThread, loadThreadConversation } from "@/lib/communication/conversation-key.server";
import { resetConversationSchemaProbe } from "@/lib/communication/conversation-thread.server";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

/**
 * The server-side reply check: a reply written into thread T and delivered to
 * recipient R must be the SAME person. Before keys it was possible to store the
 * reply in one conversation and deliver it to another.
 */

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
const M = "11111111-0000-4000-8000-00000000000a";
const R = "22222222-0000-4000-8000-00000000000b";
const R2 = "33333333-0000-4000-8000-00000000000c";
const CO = "44444444-0000-4000-8000-00000000000d";
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1";

function db() {
  return createConversationFakeDb({
    profiles: [
      { id: M, email: "manager@x.co" },
      { id: R, email: "resident@x.co" },
      { id: R2, email: "other@x.co" },
      { id: CO, email: "co@x.co" },
    ],
    portal_workspaces: [{ id: W1, owner_user_id: M, is_default: true }],
    manager_property_records: [{ id: "H1", manager_user_id: M, workspace_id: W1 }],
    manager_application_records: [
      { manager_user_id: M, resident_email: "resident@x.co", property_id: "H1", row_data: {} },
      { manager_user_id: M, resident_email: "other@x.co", property_id: "H1", row_data: {} },
    ],
    account_link_invites: [{ invitee_user_id: CO, inviter_user_id: M, status: "accepted", workspace_id: W1 }],
    portal_lease_pipeline_records: [],
    manager_vendor_records: [],
    portal_inbox_thread_records: [
      { id: "t-keyed", scope: MANAGER_SCOPE, owner_user_id: M, conversation_key: `acct:${R}`, workspace_id: W1, row_data: { email: "resident@x.co" } },
      { id: "t-res", scope: RESIDENT_SCOPE, owner_user_id: R, conversation_key: `ws:${W1}`, workspace_id: W1, row_data: { email: "manager@x.co" } },
    ],
  });
}

const keyedThread = {
  id: "t-keyed",
  scope: MANAGER_SCOPE,
  ownerUserId: M,
  conversationKey: `acct:${R}`,
  workspaceId: W1,
  email: "resident@x.co",
};

beforeEach(() => resetConversationSchemaProbe());

describe("replyRecipientsMatchThread", () => {
  it("a keyed person thread accepts only the person it is with", async () => {
    const fake = db();
    expect(
      await replyRecipientsMatchThread(fake, {
        thread: keyedThread,
        senderUserId: M,
        recipients: [{ email: "resident@x.co", userId: R }],
        propertyId: "H1",
      }),
    ).toEqual({ ok: true });
    expect(
      await replyRecipientsMatchThread(fake, {
        thread: keyedThread,
        senderUserId: M,
        recipients: [{ email: "other@x.co", userId: R2 }],
        propertyId: "H1",
      }),
    ).toEqual({ ok: false, recipientEmail: "other@x.co" });
  });

  it("every recipient must be the thread's person, not just one of them", async () => {
    const result = await replyRecipientsMatchThread(db(), {
      thread: keyedThread,
      senderUserId: M,
      recipients: [
        { email: "resident@x.co", userId: R },
        { email: "other@x.co", userId: R2 },
      ],
    });
    expect(result).toEqual({ ok: false, recipientEmail: "other@x.co" });
  });

  it("a legacy thread is judged by the email it was stored under", async () => {
    const legacy = { ...keyedThread, conversationKey: null, workspaceId: null };
    const fake = db();
    expect(
      await replyRecipientsMatchThread(fake, { thread: legacy, senderUserId: M, recipients: [{ email: "Resident@X.co", userId: R }] }),
    ).toEqual({ ok: true });
    expect(
      await replyRecipientsMatchThread(fake, { thread: legacy, senderUserId: M, recipients: [{ email: "other@x.co", userId: R2 }] }),
    ).toEqual({ ok: false, recipientEmail: "other@x.co" });
  });

  it("a legacy property reply that also fans out to co-managers needs only the primary counterparty to match", async () => {
    const legacyResidentThread = { ...keyedThread, scope: RESIDENT_SCOPE, ownerUserId: R, conversationKey: null, workspaceId: null, email: "manager@x.co" };
    const result = await replyRecipientsMatchThread(db(), {
      thread: legacyResidentThread,
      senderUserId: R,
      recipients: [
        { email: "manager@x.co", userId: M },
        { email: "co@x.co", userId: CO },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("a legacy thread with no counterparty email has nothing to compare and is not blocked", async () => {
    const result = await replyRecipientsMatchThread(db(), {
      thread: { ...keyedThread, conversationKey: null, workspaceId: null, email: "" },
      senderUserId: M,
      recipients: [{ email: "resident@x.co", userId: R }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("a resident's workspace thread accepts the owner and an accepted co-manager, and refuses a stranger", async () => {
    const thread = { ...keyedThread, id: "t-res", scope: RESIDENT_SCOPE, ownerUserId: R, conversationKey: `ws:${W1}`, workspaceId: W1, email: "manager@x.co" };
    const fake = db();
    expect(
      await replyRecipientsMatchThread(fake, {
        thread,
        senderUserId: R,
        recipients: [
          { email: "manager@x.co", userId: M },
          { email: "co@x.co", userId: CO },
        ],
      }),
    ).toEqual({ ok: true });
    expect(
      await replyRecipientsMatchThread(fake, { thread, senderUserId: R, recipients: [{ email: "other@x.co", userId: R2 }] }),
    ).toEqual({ ok: false, recipientEmail: "other@x.co" });
  });
});

describe("loadThreadConversation", () => {
  it("reads the stored key and workspace, and degrades to none", async () => {
    const fake = db();
    expect(await loadThreadConversation(fake, "t-keyed")).toEqual({ conversationKey: `acct:${R}`, workspaceId: W1 });
    expect(await loadThreadConversation(fake, "missing")).toEqual({ conversationKey: null, workspaceId: null });
  });
});
