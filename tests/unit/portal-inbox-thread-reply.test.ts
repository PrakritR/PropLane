import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendInboxThreadReply, coHostDisplayName, resolveInboxThreadReplyTarget } from "@/lib/portal-inbox-delivery";
import { visibleInboxThreadRecord } from "@/lib/communication/conversation-visibility.server";
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
  it("routes an existing canonical escalation thread back to its owner's bot", async () => {
    const { db } = makeDb([{
      id: "agent_notice_manager_a", owner_user_id: "manager_a", participant_email: null,
      scope: "axis_portal_inbox_manager_v1", thread_type: "leasing_sms_escalation", row_data: {},
    }]);
    expect(await resolveInboxThreadReplyTarget(db, { ...baseOpts, threadId: "agent_notice_manager_a" }))
      .toMatchObject({ threadType: "agent_notice", ownerUserId: "manager_a" });
    expect(await resolveInboxThreadReplyTarget(db, {
      threadId: "agent_notice_manager_a", senderUserId: "foreign", senderEmail: "foreign@example.com",
    })).toBeNull();
  });

  it("does not turn a person named PropLane Assistant into the bot", async () => {
    const { db } = makeDb([{
      id: "person-thread", owner_user_id: "manager_a", participant_email: null,
      scope: "axis_portal_inbox_manager_v1", thread_type: "portal_message",
      row_data: { from: "PropLane Assistant" },
    }]);
    expect(await resolveInboxThreadReplyTarget(db, { ...baseOpts, threadId: "person-thread" }))
      .toMatchObject({ threadType: "portal_message" });
  });
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
          row_data: { messages: [], propertyId: "prop-1" },
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
          row_data: { messages: [], propertyId: "prop-1" },
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

/**
 * One host-team thread per prospect (A4): the tour request is ONE turn in the owner's conversation, stamped with the house.
 * A co-manager holding that house with Communication sees it and answers as themselves, signed "<first name> · Co-host";
 * one holding another house sees nothing and cannot post.
 */
describe("host-team thread: co-host visibility and attribution", () => {
  const leadThread = {
    id: "lead-1",
    owner_user_id: "owner_1",
    participant_email: null,
    scope: "axis_portal_inbox_manager_v1",
    thread_type: "portal_message",
    row_data: {
      propertyId: "prop-1",
      email: "jordan@example.com",
      messages: [{ id: "lead-a", from: "Jordan Lee", body: "Tour request", at: "Oct 26", outbound: false, houseId: "prop-1", houseLabel: "Cedar Court" }],
    },
  };
  const profiles = [
    { id: "co_mgr", email: "co@axis.test", full_name: "Dev Patel" },
    { id: "co_other", email: "other@axis.test", full_name: "Sam Roe" },
    { id: "owner_1", email: "owner@axis.test", full_name: "Ambika Magos" },
  ];
  const grant = (invitee: string, propertyId: string, level: Record<string, boolean>) => ({
    id: `link-${invitee}`,
    status: "accepted",
    inviter_user_id: "owner_1",
    invitee_user_id: invitee,
    assigned_property_ids: [propertyId],
    property_co_manager_permissions: { [propertyId]: { inbox: level } },
  });
  const world = () =>
    makeWritableCtx({
      portal_inbox_thread_records: [structuredClone(leadThread)],
      profiles,
      account_link_invites: [grant("co_mgr", "prop-1", { read: true, edit: true }), grant("co_other", "prop-2", { read: true, edit: true })],
    });
  const row = () => ({
    id: "lead-1",
    owner_user_id: "owner_1",
    participant_email: null,
    thread_type: "portal_message",
    row_data: leadThread.row_data,
  });

  it("a co-manager holding the house sees the owner's thread; one holding another house does not", async () => {
    const { ctx } = world();
    const db = ctx.db as unknown as SupabaseClient;
    expect(await visibleInboxThreadRecord(db, "co_mgr", "read", row())).not.toBeNull();
    expect(await visibleInboxThreadRecord(db, "co_other", "read", row())).toBeNull();
  });

  it("a co-host's reply posts into the owner's conversation as themselves, signed '<first name> · Co-host'", async () => {
    const { ctx, store } = world();
    const db = ctx.db as unknown as SupabaseClient;
    const result = await appendInboxThreadReply(db, {
      threadId: "lead-1", senderUserId: "co_mgr", senderEmail: "co@axis.test", fromName: "Dev Patel", text: "Yes, two street spots.",
    });
    expect(result.ok).toBe(true);
    const rows = store.portal_inbox_thread_records!;
    expect(rows).toHaveLength(1);
    const messages = (rows[0]!.row_data as { messages: Record<string, unknown>[] }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ from: "Dev Patel", body: "Yes, two street spots.", senderUserId: "co_mgr", senderDisplayName: "Dev · Co-host" });
    expect(rows[0]!.owner_user_id).toBe("owner_1");
  });

  it("the owner's own reply carries senderUserId but no label (owner unlabeled)", async () => {
    const { ctx, store } = world();
    const db = ctx.db as unknown as SupabaseClient;
    await appendInboxThreadReply(db, {
      threadId: "lead-1", senderUserId: "owner_1", senderEmail: "owner@axis.test", fromName: "Ambika Magos", text: "See you Saturday.",
    });
    const messages = (store.portal_inbox_thread_records![0]!.row_data as { messages: Record<string, unknown>[] }).messages;
    expect(messages[1]).toMatchObject({ senderUserId: "owner_1" });
    expect(messages[1]).not.toHaveProperty("senderDisplayName");
  });

  it("a co-manager holding a different house cannot post into it (re-derived server-side), and nothing is written", async () => {
    const { ctx, store } = world();
    const db = ctx.db as unknown as SupabaseClient;
    const result = await appendInboxThreadReply(db, {
      threadId: "lead-1", senderUserId: "co_other", senderEmail: "other@axis.test", fromName: "Sam Roe", text: "should not land",
    });
    expect(result.ok).toBe(false);
    expect((store.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("the co-host label uses the first name only, and never an email address", () => {
    expect(coHostDisplayName("Dev Patel")).toBe("Dev · Co-host");
    expect(coHostDisplayName("  Priya  ")).toBe("Priya · Co-host");
    expect(coHostDisplayName("dev@axis.test")).toBe("Co-host");
    expect(coHostDisplayName("")).toBe("Co-host");
  });
});
