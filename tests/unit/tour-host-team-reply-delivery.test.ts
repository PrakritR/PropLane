import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coHostDisplayName,
  deliverPortalMessageThreadSide,
  replyDeliveryContext,
  resolveInboxThreadReplyTarget,
} from "@/lib/portal-inbox-delivery";
import { makeWritableCtx } from "./tools/fake-agent-ctx";

/**
 * A co-host's reply on the tour host-team thread must reach the resident exactly as the owner's does. The resident's side of
 * the conversation is found under the OWNER's workspace; resolved under the co-host's own default workspace it was never
 * found and the resident's record stayed empty.
 */

const WS = "ws-owner";
const WS_CASEY = "ws-casey";
const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";

function world() {
  return makeWritableCtx({
    portal_workspaces: [
      { id: WS, owner_user_id: "owner_1", is_default: true },
      { id: WS_CASEY, owner_user_id: "casey", is_default: true },
    ],
    manager_property_records: [{ id: "prop-1", manager_user_id: "owner_1", workspace_id: WS }],
    profiles: [
      { id: "owner_1", email: "owner@axis.test", full_name: "Ambika Magos" },
      { id: "casey", email: "casey@axis.test", full_name: "Casey Brooks" },
      { id: "tess", email: "tess@axis.test", full_name: "Tess Tourist" },
    ],
    account_link_invites: [{
      id: "link-casey", status: "accepted", inviter_user_id: "owner_1", invitee_user_id: "casey", workspace_id: WS, team_role: "co_manager",
      assigned_property_ids: ["prop-1"], property_co_manager_permissions: { "prop-1": { inbox: { read: true, edit: true } } },
    }],
    portal_inbox_thread_records: [
      {
        id: "property_mgr_x:manager", scope: MANAGER_SCOPE, owner_user_id: "owner_1", participant_email: "tess@axis.test",
        thread_type: "portal_message", conversation_key: "mail:tess@axis.test", workspace_id: WS,
        row_data: { id: "property_mgr_x:manager", folder: "inbox", from: "Tess Tourist", email: "tess@axis.test", propertyId: "prop-1", workspaceId: WS, messages: [] },
      },
      {
        id: "property_mgr_x", scope: RESIDENT_SCOPE, owner_user_id: "tess", participant_email: "tess@axis.test",
        thread_type: "portal_message", conversation_key: `ws:${WS}`, workspace_id: WS,
        row_data: { id: "property_mgr_x", folder: "inbox", from: "Property manager (Cedar)", email: "", propertyId: "prop-1", managerUserId: "owner_1", workspaceId: WS, conversationKey: `ws:${WS}` },
      },
    ],
  });
}

const residentMessages = (store: Record<string, Record<string, unknown>[]>) =>
  ((store.portal_inbox_thread_records!.find((r) => r.id === "property_mgr_x")!.row_data as { messages?: Record<string, unknown>[] }).messages ?? []);

/** What the send route does for the recipient's copy, with the hints it passes. */
async function deliverToResident(db: SupabaseClient, sender: string, fromName: string, useContext: boolean) {
  const target = await resolveInboxThreadReplyTarget(db, { threadId: "property_mgr_x:manager", senderUserId: sender, senderEmail: `${sender}@axis.test` });
  expect(target).not.toBeNull();
  const host = useContext ? replyDeliveryContext(target, { senderUserId: sender, threadWorkspaceId: WS }) : null;
  const coHost = Boolean(host && !host.ownedBySender);
  await deliverPortalMessageThreadSide(db, {
    scope: RESIDENT_SCOPE,
    folder: "inbox",
    ownerUserId: "tess",
    participantEmail: "tess@axis.test",
    otherPartyEmail: `${sender}@axis.test`,
    conversation: {
      propertyId: host?.propertyId ?? null,
      otherPartyUserId: sender,
      managerUserId: host?.managerUserId ?? sender,
      ...(host?.workspaceId ? { workspaceId: host.workspaceId } : {}),
    },
    ...(coHost ? { senderDisplayName: coHostDisplayName(fromName) } : {}),
    fallbackId: "msg_inbox_new",
    fromName,
    subject: "Re: Tour request",
    body: "2 pm works, see you at the house.",
    preview: "2 pm works",
    when: "Oct 26, 6:15 PM",
    unread: true,
    outbound: false,
  });
}

describe("a co-host's reply on the tour host-team thread reaches the resident", () => {
  it("the owner's reply lands on the resident's conversation (the baseline)", async () => {
    const { ctx, store } = world();
    await deliverToResident((ctx as unknown as { db: SupabaseClient }).db, "owner_1", "Ambika Magos", true);
    expect(residentMessages(store)).toHaveLength(1);
  });

  it("Casey's reply lands on the SAME resident conversation, signed 'Casey · Co-host', with no duplicate thread", async () => {
    const { ctx, store } = world();
    await deliverToResident((ctx as unknown as { db: SupabaseClient }).db, "casey", "Casey Brooks", true);
    const messages = residentMessages(store);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "2 pm works, see you at the house.", senderDisplayName: "Casey · Co-host" });
    expect(store.portal_inbox_thread_records!.filter((r) => r.scope === RESIDENT_SCOPE)).toHaveLength(1);
  });

  it("(the bug) resolving under the co-host's own workspace misses the resident's conversation", async () => {
    const { ctx, store } = world();
    await deliverToResident((ctx as unknown as { db: SupabaseClient }).db, "casey", "Casey Brooks", false);
    expect(residentMessages(store)).toHaveLength(0);
  });

  it("only the co-host is flagged: the owner owns their reply, so no co-host label", async () => {
    const { ctx } = world();
    const db = (ctx as unknown as { db: SupabaseClient }).db;
    const owner = await resolveInboxThreadReplyTarget(db, { threadId: "property_mgr_x:manager", senderUserId: "owner_1", senderEmail: "owner@axis.test" });
    expect(replyDeliveryContext(owner, { senderUserId: "owner_1", threadWorkspaceId: WS })).toMatchObject({ ownedBySender: true, managerUserId: "owner_1", workspaceId: WS, propertyId: "prop-1" });
    const casey = await resolveInboxThreadReplyTarget(db, { threadId: "property_mgr_x:manager", senderUserId: "casey", senderEmail: "casey@axis.test" });
    expect(replyDeliveryContext(casey, { senderUserId: "casey", threadWorkspaceId: WS })).toMatchObject({ ownedBySender: false, managerUserId: "owner_1" });
  });

  it("a co-manager holding a different house cannot post on the thread", async () => {
    const { ctx, store } = world();
    store.account_link_invites!.push({
      id: "link-sam", status: "accepted", inviter_user_id: "owner_1", invitee_user_id: "sam", workspace_id: WS, team_role: "co_manager",
      assigned_property_ids: ["prop-2"], property_co_manager_permissions: { "prop-2": { inbox: { read: true, edit: true } } },
    });
    const db = (ctx as unknown as { db: SupabaseClient }).db;
    expect(await resolveInboxThreadReplyTarget(db, { threadId: "property_mgr_x:manager", senderUserId: "sam", senderEmail: "sam@axis.test" })).toBeNull();
  });
});

describe("the send route delivers a reply under the thread owner's workspace", () => {
  it("passes the thread's owner, workspace and house to the recipient copy, and writes no sent copy for a co-host", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/portal/send-inbox-message/route.ts", "utf8");
    expect(route).toContain("replyDeliveryContext(replyTarget");
    expect(route).toContain("hostReply?.managerUserId");
    expect(route).toContain("hostReply?.workspaceId");
    expect(route).toMatch(/if \(!coHostReply\) await deliverPortalMessageThreadSide/);
    expect(route).toContain("senderDisplayName: coHostDisplayName(fromName)");
  });
});
