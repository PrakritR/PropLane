import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendInboxThreadReply } from "@/lib/portal-inbox-delivery";
import { makeWritableCtx } from "./tools/fake-agent-ctx";

/**
 * appendInboxThreadReply carries the ownership check that used to live inline
 * in the send-inbox-message route: the thread's owner, its participant, or a
 * co-manager with Communication edit on that owner may append; anything else
 * is a silent no-op. These tests pin that behavior now that both the route
 * and the agent messaging tool call it.
 */

function makeDb(threads: Record<string, unknown>[]) {
  const { ctx, store } = makeWritableCtx({ portal_inbox_thread_records: threads });
  return { db: (ctx as unknown as { db: SupabaseClient }).db, store };
}

const baseOpts = {
  senderUserId: "manager_a",
  senderEmail: "manager@axis.test",
  fromName: "PropLane Portal",
  text: "reply body",
};

describe("appendInboxThreadReply", () => {
  it("appends a message to a thread the sender owns", async () => {
    const { db, store } = makeDb([
      {
        id: "t1",
        owner_user_id: "manager_a",
        participant_email: null,
        scope: "axis_portal_inbox_manager_v1",
        row_data: { subject: "Rent", messages: [{ id: "m1", from: "Pat", body: "hi", at: "Jun 1" }] },
      },
    ]);
    const result = await appendInboxThreadReply(db, { ...baseOpts, threadId: "t1" });
    expect(result.ok).toBe(true);
    const rowData = store.portal_inbox_thread_records![0]!.row_data as {
      messages: unknown[];
      preview: string;
      unread: boolean;
    };
    expect(rowData.messages).toHaveLength(2);
    expect(rowData.preview).toBe("reply body");
    expect(rowData.unread).toBe(false);
  });

  it("appends when the sender is the thread participant (by email)", async () => {
    const { db, store } = makeDb([
      {
        id: "t1",
        owner_user_id: "someone_else",
        participant_email: "manager@axis.test",
        scope: "axis_portal_inbox_resident_v1",
        row_data: { messages: [] },
      },
    ]);
    const result = await appendInboxThreadReply(db, { ...baseOpts, threadId: "t1" });
    expect(result.ok).toBe(true);
    expect((store.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("is a no-op for a thread the sender neither owns nor participates in", async () => {
    const { db, store } = makeDb([
      {
        id: "t1",
        owner_user_id: "someone_else",
        participant_email: "other@example.com",
        scope: "axis_portal_inbox_manager_v1",
        row_data: { messages: [] },
      },
    ]);
    const result = await appendInboxThreadReply(db, { ...baseOpts, threadId: "t1" });
    expect(result.ok).toBe(false);
    expect((store.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("appends when the sender is a co-manager with Communication edit on the thread owner", async () => {
    const { ctx, store } = makeWritableCtx({
      portal_inbox_thread_records: [
        {
          id: "t1",
          owner_user_id: "owner_1",
          participant_email: "resident@example.com",
          scope: "axis_portal_inbox_manager_v1",
          row_data: { messages: [] },
        },
      ],
      profiles: [
        { id: "co_mgr", email: "co@axis.test" },
        { id: "owner_1", email: "owner@axis.test" },
      ],
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: "owner_1",
          invitee_user_id: "co_mgr",
          assigned_property_ids: ["prop-1"],
          property_co_manager_permissions: { "prop-1": { inbox: { read: true, edit: true } } },
        },
      ],
    });
    const result = await appendInboxThreadReply(ctx.db as unknown as SupabaseClient, {
      threadId: "t1",
      senderUserId: "co_mgr",
      senderEmail: "co@axis.test",
      fromName: "Co-manager",
      text: "reply as co-manager",
    });
    expect(result.ok).toBe(true);
    expect(
      (store.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] }).messages,
    ).toHaveLength(1);
  });

  it("is a no-op when the co-manager only has Communication read on the thread owner", async () => {
    const { ctx, store } = makeWritableCtx({
      portal_inbox_thread_records: [
        {
          id: "t1",
          owner_user_id: "owner_1",
          participant_email: "resident@example.com",
          scope: "axis_portal_inbox_manager_v1",
          row_data: { messages: [] },
        },
      ],
      profiles: [
        { id: "co_mgr", email: "co@axis.test" },
        { id: "owner_1", email: "owner@axis.test" },
      ],
      account_link_invites: [
        {
          id: "link-1",
          status: "accepted",
          inviter_user_id: "owner_1",
          invitee_user_id: "co_mgr",
          assigned_property_ids: ["prop-1"],
          property_co_manager_permissions: { "prop-1": { inbox: { read: true } } },
        },
      ],
    });
    const result = await appendInboxThreadReply(ctx.db as unknown as SupabaseClient, {
      threadId: "t1",
      senderUserId: "co_mgr",
      senderEmail: "co@axis.test",
      fromName: "Co-manager",
      text: "should not land",
    });
    expect(result.ok).toBe(false);
    expect(
      (store.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] }).messages,
    ).toHaveLength(0);
  });

  it("is a no-op for unknown or blank thread ids", async () => {
    const { db } = makeDb([]);
    expect((await appendInboxThreadReply(db, { ...baseOpts, threadId: "missing" })).ok).toBe(false);
    expect((await appendInboxThreadReply(db, { ...baseOpts, threadId: "  " })).ok).toBe(false);
  });
});
