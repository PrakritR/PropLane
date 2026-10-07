/**
 * Owner Documents list only files marked Shared with owners on houses the owner
 * may open documents for, with bytes only through a server-minted signed URL.
 * Owner Messages is the owner's own thread with the manager of their own
 * membership: the recipient is never taken from the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivered: Record<string, unknown>[] = [];
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn(async (_db: unknown, opts: Record<string, unknown>) => {
    delivered.push(opts);
    return { ok: true, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] };
  }),
}));

import type { OwnerGrant } from "@/lib/property-owner/access.server";
import { loadOwnerDocuments, mintOwnerDocumentUrl } from "@/lib/property-owner/documents.server";
import { loadOwnerConversations, OwnerMessageError, sendOwnerMessage } from "@/lib/property-owner/messages.server";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const OWNER = "owner-1";
const DOC_OK = "11111111-1111-4111-8111-111111111111";
const DOC_UNSHARED = "22222222-2222-4222-8222-222222222222";
const DOC_OTHER_HOUSE = "33333333-3333-4333-8333-333333333333";
const DOC_DELETED = "44444444-4444-4444-8444-444444444444";
const DOC_NO_HOUSE = "55555555-5555-4555-8555-555555555555";

function doc(id: string, over: Record<string, unknown>) {
  return {
    id,
    manager_user_id: MANAGER,
    property_id: "house-a",
    display_name: `Doc ${id.slice(0, 2)}`,
    original_filename: null,
    mime_type: "application/pdf",
    size_bytes: 1200,
    created_at: "2026-10-01T00:00:00Z",
    storage_path: `manager/${MANAGER}/${id}.pdf`,
    shared_with_owners: true,
    deleted_at: null,
    superseded_by_document_id: null,
    ...over,
  };
}

const rows = [
  doc(DOC_OK, {}),
  doc(DOC_UNSHARED, { shared_with_owners: false }),
  doc(DOC_OTHER_HOUSE, { property_id: "house-b" }),
  doc(DOC_DELETED, { deleted_at: "2026-10-02T00:00:00Z" }),
  doc(DOC_NO_HOUSE, { property_id: null }),
];

const grants = (documents = true, messages = false): OwnerGrant[] => [
  { linkId: "link-1", managerUserId: MANAGER, houses: [{ propertyId: "house-a", performance: true, statements: true, documents, messages }] },
];

function dbWithStorage(tables: Record<string, Record<string, unknown>[]>) {
  const db = makeFakeDb(tables) as unknown as Record<string, unknown>;
  db.storage = { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }) }) };
  return db as never;
}

describe("owner documents", () => {
  it("lists only shared, live files on a granted house, as title/type/size/date", async () => {
    const list = await loadOwnerDocuments(dbWithStorage({ manager_documents: rows }), grants());
    expect(list.map((d) => d.id)).toEqual([DOC_OK]);
    expect(Object.keys(list[0]!).sort()).toEqual(["createdAt", "id", "mimeType", "sizeBytes", "title"]);
  });

  it("lists nothing when the documents key is off", async () => {
    expect(await loadOwnerDocuments(dbWithStorage({ manager_documents: rows }), grants(false))).toEqual([]);
  });

  it("mints a signed URL for a shared file on a granted house", async () => {
    const out = await mintOwnerDocumentUrl(dbWithStorage({ manager_documents: rows }), grants(), DOC_OK, false);
    expect(out?.url).toBe(`https://signed.test/manager/${MANAGER}/${DOC_OK}.pdf`);
  });

  it("refuses everything else with the same null: unshared, other house, deleted, no house, bad id, key off", async () => {
    const db = dbWithStorage({ manager_documents: rows });
    for (const id of [DOC_UNSHARED, DOC_OTHER_HOUSE, DOC_DELETED, DOC_NO_HOUSE, "not-a-uuid", "99999999-9999-4999-8999-999999999999"]) {
      expect(await mintOwnerDocumentUrl(db, grants(), id, false), id).toBeNull();
    }
    expect(await mintOwnerDocumentUrl(db, grants(false), DOC_OK, false)).toBeNull();
  });

  it("refuses a file whose path does not sit under its own manager's folder", async () => {
    const planted = [doc(DOC_OK, { storage_path: "manager/someone-else/secret.pdf" })];
    expect(await mintOwnerDocumentUrl(dbWithStorage({ manager_documents: planted }), grants(), DOC_OK, false)).toBeNull();
  });
});

describe("owner messages", () => {
  beforeEach(() => {
    delivered.length = 0;
  });
  const untouchable = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as never;

  it("is refused as not found while Messages is off for the owner", async () => {
    await expect(sendOwnerMessage(untouchable, OWNER, grants(true, false), { conversationId: "link-1", body: "hi" })).rejects.toMatchObject({ status: 404 });
    expect(await loadOwnerConversations(untouchable, OWNER, grants(true, false))).toEqual([]);
    expect(delivered).toHaveLength(0);
  });

  it("a conversation id that is not one of the owner's own memberships is not found", async () => {
    await expect(sendOwnerMessage(untouchable, OWNER, grants(true, true), { conversationId: "someone-elses-link", body: "hi" })).rejects.toBeInstanceOf(OwnerMessageError);
    expect(delivered).toHaveLength(0);
  });

  it("sends to the manager of the owner's own membership, whatever else the request says", async () => {
    const db = makeFakeDb({ profiles: [{ id: OWNER, email: "dana@example.com", full_name: "Dana" }] });
    await sendOwnerMessage(db, OWNER, grants(true, true), { conversationId: "link-1", body: "  Is the roof done?  " });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ senderUserId: OWNER, toUserIds: [MANAGER], text: "Is the roof done?", deliverViaEmail: false, deliverViaSms: false, recipientsAuthorizedByCaller: true });
    expect(delivered[0]!.toEmails).toBeUndefined();
    expect(delivered[0]!.broadcastCategories).toBeUndefined();
  });

  it("refuses an empty or oversized message", async () => {
    await expect(sendOwnerMessage(untouchable, OWNER, grants(true, true), { conversationId: "link-1", body: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(sendOwnerMessage(untouchable, OWNER, grants(true, true), { conversationId: "link-1", body: "x".repeat(4001) })).rejects.toMatchObject({ status: 400 });
  });

  it("reads only the owner's own rows with that manager, as body/time/direction", async () => {
    const db = makeFakeDb({
      profiles: [
        { id: OWNER, email: "dana@example.com", full_name: "Dana" },
        { id: MANAGER, email: "manager@example.com", full_name: "Mgr" },
      ],
      portal_inbox_thread_records: [
        {
          scope: "axis_portal_inbox_manager_v1",
          owner_user_id: OWNER,
          participant_email: "manager@example.com",
          row_data: { messages: [{ id: "m1", from: "Mgr", body: "Hello", at: "2026-10-01T10:00:00Z", outbound: false, attachments: [{ url: "x" }] }, { id: "m2", from: "dana@example.com", body: "Thanks", at: "2026-10-01T11:00:00Z" }] },
        },
        // The manager's side and a resident thread: never selected.
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: MANAGER, participant_email: "dana@example.com", row_data: { messages: [{ id: "x", body: "manager's own copy", at: "2026-10-01T10:00:00Z" }] } },
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: OWNER, participant_email: "resident@example.com", row_data: { messages: [{ id: "r", body: "resident secret", at: "2026-10-01T10:00:00Z" }] } },
      ],
    });
    const conversations = await loadOwnerConversations(db, OWNER, grants(true, true));
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages).toEqual([
      { id: "m1", body: "Hello", at: "2026-10-01T10:00:00Z", fromMe: false },
      { id: "m2", body: "Thanks", at: "2026-10-01T11:00:00Z", fromMe: true },
    ]);
    expect(JSON.stringify(conversations)).not.toContain("resident secret");
    expect(JSON.stringify(conversations)).not.toContain("manager's own copy");
  });
  it("reads the one-message rows the inbox writes per send (no participant_email, folder says the side)", async () => {
    const db = makeFakeDb({
      profiles: [
        { id: OWNER, email: "dana@example.com", full_name: "Dana" },
        { id: MANAGER, email: "manager@example.com", full_name: "Mgr" },
      ],
      portal_inbox_thread_records: [
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: OWNER, participant_email: null, created_at: "2026-10-01T10:00:00Z", row_data: { id: "s1", body: "Is the roof done?", email: "manager@example.com", folder: "sent" } },
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: OWNER, participant_email: null, created_at: "2026-10-01T11:00:00Z", row_data: { id: "i1", body: "Yes", email: "manager@example.com", folder: "inbox" } },
        // A later turn appends to `messages` while the root stays in `body`.
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: OWNER, participant_email: null, created_at: "2026-10-01T10:30:00Z", row_data: { id: "r0", body: "Root", folder: "sent", email: "manager@example.com", messages: [{ id: "r1", body: "Reply", at: "2026-10-01T10:45:00Z", outbound: false }] } },
        { scope: "axis_portal_inbox_manager_v1", owner_user_id: OWNER, participant_email: null, created_at: "2026-10-01T12:00:00Z", row_data: { id: "x1", body: "someone else", email: "resident@example.com", folder: "inbox" } },
      ],
    });
    const conversations = await loadOwnerConversations(db, OWNER, grants(true, true));
    expect(conversations[0]!.messages).toEqual([
      { id: "s1", body: "Is the roof done?", at: "2026-10-01T10:00:00Z", fromMe: true },
      { id: "r0", body: "Root", at: "2026-10-01T10:30:00Z", fromMe: true },
      { id: "r1", body: "Reply", at: "2026-10-01T10:45:00Z", fromMe: false },
      { id: "i1", body: "Yes", at: "2026-10-01T11:00:00Z", fromMe: false },
    ]);
  });
});
