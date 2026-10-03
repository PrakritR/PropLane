import { beforeEach, describe, expect, it } from "vitest";
import {
  deliverPortalMessageThreadSide,
  findExistingPortalMessageThread,
} from "@/lib/portal-inbox-delivery";
import { resolveConversationRef } from "@/lib/communication/conversation-key.server";
import { resetConversationSchemaProbe } from "@/lib/communication/conversation-thread.server";
import { createConversationFakeDb, type FakeDb } from "../helpers/conversation-fake-db";

/**
 * Part B of comms-safety-0929: ONE conversation per person per workspace.
 *
 * The resolver decides (account -> verified phone -> email); the database
 * function creates; every writer goes through `deliverPortalMessageThreadSide`.
 * These tests drive the writer against an in-memory twin of the RPC contract.
 */

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";

const M = "11111111-0000-4000-8000-00000000000a"; // manager / workspace owner
const R = "22222222-0000-4000-8000-00000000000b"; // resident with an account
const R2 = "33333333-0000-4000-8000-00000000000c"; // another resident
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1"; // default workspace
const W2 = "aaaaaaaa-0000-4000-8000-0000000000a2";

function seededDb(extra: Record<string, Record<string, unknown>[]> = {}): FakeDb {
  return createConversationFakeDb({
    profiles: [
      { id: M, email: "manager@x.co", role: "manager" },
      { id: R, email: "resident@x.co", phone: "+15105551234", phone_verified_at: "2026-09-01T00:00:00Z", role: "resident" },
      { id: R2, email: "other@x.co", phone: "+15105559999", phone_verified_at: null, role: "resident" },
    ],
    portal_workspaces: [
      { id: W1, owner_user_id: M, is_default: true },
      { id: W2, owner_user_id: M, is_default: false },
    ],
    manager_property_records: [
      { id: "H1", manager_user_id: M, workspace_id: W1 },
      { id: "H2", manager_user_id: M, workspace_id: W2 },
    ],
    manager_application_records: [
      { manager_user_id: M, resident_email: "resident@x.co", property_id: "H1", row_data: { bucket: "approved" } },
    ],
    account_link_invites: [],
    portal_lease_pipeline_records: [],
    manager_vendor_records: [],
    portal_inbox_thread_records: [],
    ...extra,
  });
}

let counter = 0;
function managerSide(over: Record<string, unknown> = {}) {
  counter += 1;
  return {
    scope: MANAGER_SCOPE,
    folder: "inbox" as const,
    ownerUserId: M,
    participantEmail: "manager@x.co",
    otherPartyEmail: "resident@x.co",
    fallbackId: `thread-${counter}`,
    fromName: "Resident",
    subject: "Hello",
    body: `message ${counter}`,
    preview: `message ${counter}`,
    when: "Oct 3, 9:00 AM",
    unread: true,
    outbound: false,
    ...over,
  };
}

function managerRows(db: FakeDb) {
  return db.tables.portal_inbox_thread_records!.filter((row) => row.owner_user_id === M);
}

beforeEach(() => {
  resetConversationSchemaProbe();
  counter = 0;
});

describe("the resolver places a message in a workspace under a person key", () => {
  it("a resident linked to the workspace by an application is keyed by account", async () => {
    const db = seededDb();
    const ref = await resolveConversationRef(db, managerSide(), { propertyId: "H1" });
    expect(ref).toMatchObject({ workspaceId: W1, key: `acct:${R}` });
    expect(ref!.keys).toEqual([`acct:${R}`, "mail:resident@x.co"]);
  });

  it("the same person in a workspace they have no link to is keyed by email there", async () => {
    const db = seededDb();
    const ref = await resolveConversationRef(db, managerSide(), { propertyId: "H2" });
    expect(ref).toMatchObject({ workspaceId: W2, key: "mail:resident@x.co" });
  });

  it("an unverified phone on a profile never makes the number an account key", async () => {
    const db = seededDb();
    const ref = await resolveConversationRef(
      db,
      managerSide({ otherPartyEmail: "stranger@x.co" }),
      { otherPartyPhone: "+15105559999" },
    );
    // R2's phone is unverified: the number is just a phone, never R2's account.
    expect(ref?.key).toBe("tel:+15105559999");
    expect(ref?.keys).toEqual(["tel:+15105559999"]);
  });

  it("two accounts that verified one number: the conversation is flagged and nothing merges", async () => {
    const db = seededDb({
      profiles: [
        { id: M, email: "manager@x.co", role: "manager" },
        { id: R, email: "resident@x.co", phone: "+15105551234", phone_verified_at: "2026-09-01T00:00:00Z" },
        { id: R2, email: "other@x.co", phone: "5105551234", phone_verified_at: "2026-09-02T00:00:00Z" },
      ],
      manager_application_records: [
        { manager_user_id: M, resident_email: "resident@x.co", property_id: "H1", row_data: {} },
        { manager_user_id: M, resident_email: "other@x.co", property_id: "H1", row_data: {} },
      ],
    });
    const ref = await resolveConversationRef(
      db,
      managerSide({ otherPartyEmail: "unknown@x.co" }),
      { propertyId: "H1", otherPartyPhone: "5105551234" },
    );
    expect(ref?.key).toBe("tel:+15105551234");
    expect(ref?.flagged).toMatchObject({ reason: "ambiguous_phone" });
    expect(ref?.flagged?.accountIds.sort()).toEqual([R, R2].sort());
  });

  it("the resident's own copy is keyed by the workspace they are talking to", async () => {
    const db = seededDb();
    const ref = await resolveConversationRef(
      db,
      {
        scope: RESIDENT_SCOPE,
        ownerUserId: R,
        participantEmail: "resident@x.co",
        otherPartyEmail: "manager@x.co",
      },
      { propertyId: "H1" },
    );
    expect(ref).toMatchObject({ workspaceId: W1, key: `ws:${W1}` });
  });

  it("with no workspace to name it degrades to no ref (the legacy thread)", async () => {
    const db = seededDb({ portal_workspaces: [], manager_property_records: [] });
    expect(await resolveConversationRef(db, managerSide(), {})).toBeNull();
  });
});

describe("every writer lands in the one conversation", () => {
  it("an in-app send, a property chat, a text notice and a tour notice are ONE row with a house on each turn", async () => {
    const db = seededDb();
    // 1. the resident's account email thread (first contact)
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" }, channel: "proplane" }));
    // 2. a per-property chat thread (different fallback id, different folder)
    await deliverPortalMessageThreadSide(
      db,
      managerSide({ folder: "sent", outbound: true, unread: false, participantEmail: null, conversation: { propertyId: "H1" }, channel: "email" }),
    );
    // 3. a text from a number tied to the same verified account
    await deliverPortalMessageThreadSide(
      db,
      managerSide({ conversation: { propertyId: "H1", otherPartyPhone: "(510) 555-1234" }, channel: "sms", threadType: "sms_notice" }),
    );
    // 4. a tour notice from a different writer
    await deliverPortalMessageThreadSide(
      db,
      managerSide({ conversation: { propertyId: "H1" }, threadType: "tour_notification", automated: true }),
    );

    const rows = managerRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.conversation_key).toBe(`acct:${R}`);
    expect(row.workspace_id).toBe(W1);
    const rowData = row.row_data as { messages: { houseId?: string }[]; rootHouseId?: string; conversationKey?: string };
    expect(rowData.conversationKey).toBe(`acct:${R}`);
    expect(rowData.rootHouseId).toBe("H1");
    expect(rowData.messages).toHaveLength(3);
    expect(rowData.messages.every((m) => m.houseId === "H1")).toBe(true);
    // An inbound turn into a conversation that began as a sent copy makes it an inbox conversation.
    expect((row.row_data as { folder: string }).folder).toBe("inbox");
  });

  it("the same person in another workspace is a different conversation", async () => {
    const db = seededDb();
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H2" } }));
    const rows = managerRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.workspace_id).sort()).toEqual([W1, W2]);
  });

  it("two sends at the same instant make ONE conversation (the RPC contract)", async () => {
    const db = seededDb();
    const a = deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" }, messageId: "m-a", body: "from A" }));
    const b = deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" }, messageId: "m-b", body: "from B" }));
    const [first, second] = await Promise.all([a, b]);
    const rows = managerRows(db);
    expect(rows).toHaveLength(1);
    expect(new Set([first.threadId, second.threadId]).size).toBe(1);
    const rowData = rows[0]!.row_data as { body: string; messages: { body: string }[] };
    expect([rowData.body, ...rowData.messages.map((m) => m.body)].sort()).toEqual(["from A", "from B"]);
    const creates = db.rpcCalls.filter((call) => call.fn === "resolve_or_create_conversation");
    expect(creates.length).toBeGreaterThanOrEqual(2);
  });

  it("a legacy row (no key) is adopted rather than duplicated", async () => {
    const db = seededDb({
      portal_inbox_thread_records: [
        {
          id: "legacy-1",
          scope: MANAGER_SCOPE,
          owner_user_id: M,
          participant_email: "manager@x.co",
          thread_type: "portal_message",
          row_data: { id: "legacy-1", folder: "inbox", email: "resident@x.co", body: "old", messages: [] },
          updated_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const result = await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    expect(result.threadId).toBe("legacy-1");
    const rows = managerRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_key).toBe(`acct:${R}`);
    expect(rows[0]!.workspace_id).toBe(W1);
  });

  it("a weaker-key row is found and upgraded when the person later gains an account link", async () => {
    // Stored while the resident had no application: keyed by email.
    const db = seededDb({
      manager_application_records: [],
      portal_inbox_thread_records: [],
    });
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    expect(managerRows(db)[0]!.conversation_key).toBe("mail:resident@x.co");
    // The resident now applies: the account is linked to the workspace.
    db.tables.manager_application_records!.push({
      manager_user_id: M,
      resident_email: "resident@x.co",
      property_id: "H1",
      row_data: {},
    });
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    const rows = managerRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_key).toBe(`acct:${R}`);
  });

  it("an archived conversation is not reopened by an outbound turn, only by an inbound one", async () => {
    const db = seededDb();
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    (managerRows(db)[0]!.row_data as Record<string, unknown>).folder = "trash";
    (managerRows(db)[0]!.row_data as Record<string, unknown>).previousFolder = "inbox";
    await deliverPortalMessageThreadSide(
      db,
      managerSide({ folder: "sent", outbound: true, unread: false, participantEmail: null, conversation: { propertyId: "H1" } }),
    );
    expect(managerRows(db)).toHaveLength(1);
    expect((managerRows(db)[0]!.row_data as { folder: string }).folder).toBe("trash");
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    expect(managerRows(db)).toHaveLength(1);
    expect((managerRows(db)[0]!.row_data as { folder: string }).folder).toBe("inbox");
  });

  it("the resident's copy folds every manager-side message into one ws: conversation", async () => {
    const db = seededDb();
    const side = (over: Record<string, unknown>) => ({
      scope: RESIDENT_SCOPE,
      folder: "inbox" as const,
      ownerUserId: R,
      participantEmail: "resident@x.co",
      otherPartyEmail: "manager@x.co",
      fromName: "Manager",
      subject: "s",
      preview: "p",
      when: "Oct 3, 9:00 AM",
      unread: true,
      outbound: false,
      conversation: { propertyId: "H1" },
      ...over,
    });
    await deliverPortalMessageThreadSide(db, side({ fallbackId: "r1", body: "one" }));
    await deliverPortalMessageThreadSide(db, side({ fallbackId: "r2", body: "two", threadType: "tour_notification" }));
    const rows = db.tables.portal_inbox_thread_records!.filter((row) => row.owner_user_id === R);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_key).toBe(`ws:${W1}`);
  });

  it("findExistingPortalMessageThread finds the keyed row from either folder's side", async () => {
    const db = seededDb();
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    const found = await findExistingPortalMessageThread(db, {
      scope: MANAGER_SCOPE,
      folder: "sent",
      ownerUserId: M,
      participantEmail: null,
      otherPartyEmail: "resident@x.co",
      conversation: { propertyId: "H1" },
    });
    expect(found?.matchedByKey).toBe(true);
  });
});

describe("deploy safety: the migration may not be applied yet", () => {
  it("a missing RPC falls back to the legacy create and still delivers", async () => {
    const db = seededDb();
    db.failRpc.add("resolve_or_create_conversation");
    const result = await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    expect(result.action).toBe("create");
    expect(managerRows(db)).toHaveLength(1);
  });

  it("a missing column is remembered and the write is retried without it", async () => {
    const db = seededDb();
    db.failUpsertColumns.value = true;
    db.failRpc.add("resolve_or_create_conversation");
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    await deliverPortalMessageThreadSide(db, managerSide({ conversation: { propertyId: "H1" } }));
    const rows = managerRows(db);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.conversation_key === undefined)).toBe(true);
  });
});
