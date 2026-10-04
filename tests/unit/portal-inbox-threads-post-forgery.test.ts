import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S1 (comms-safety-0929): POST /api/portal-inbox-threads used to trust the
 * scope, owner and recipient email the browser sent, so any signed-in account
 * could plant a thread in a resident's, vendor's or admin's inbox. The server
 * now decides scope (the caller must hold that portal; admin is admin-only),
 * owner (the caller) and recipient (the caller's own email, or none on a sent
 * copy).
 */

const MGR = "axis_portal_inbox_manager_v1";
const RES = "axis_portal_inbox_resident_v1";
const VEN = "axis_portal_inbox_vendor_v1";
const B = "acct-b";

const state = vi.hoisted(() => ({
  viewer: { id: "", email: "", role: "manager", name: "" },
  db: null as unknown,
  /** Stand in for a Communication grant on another owner's conversation. */
  seesOtherOwners: false,
  grantedHouses: ["H1"] as string[],
}));

vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { ...state.viewer }, db: state.db }),
  applyPortalInboxThreadScope: (
    query: { eq: (col: string, id: string) => unknown },
    user: { id: string },
    _extraOwnerIds?: string[],
    options?: { participantOnlyWhenUnowned?: boolean },
  ) => {
    if (state.seesOtherOwners) return query;
    // Manager Communication matches the viewer's email only on owner-less rows;
    // the resident / vendor scopes keep the plain participant match, so a row
    // another account owns IS reachable there.
    if (options?.participantOnlyWhenUnowned) return query.eq("owner_user_id", user.id);
    return query;
  },
}));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveCommunicationScope: async () => ({
    ownerIds: [],
    grantedHousesByOwner: new Map([["owner-1", new Set(state.grantedHouses)]]),
    workspaceHouseIds: null,
  }),
  grantedHouseIdsForOwner: (scope: { grantedHousesByOwner: Map<string, Set<string>> }, ownerId: string) =>
    scope.grantedHousesByOwner.get(ownerId) ?? new Set<string>(),
  filterVisibleInboxThreadRecords: async (_db: unknown, _scope: unknown, rows: unknown[]) => rows,
}));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({
  smsNoticeMembers: vi.fn(async () => []),
  storedSmsNoticeIdentity: () => false,
  updateSmsNoticeMailboxState: vi.fn(),
}));
vi.mock("@/lib/team-comms.server", () => ({
  isTeamThreadId: (id: string) => id.startsWith("team-thread:"),
  updateTeamThreadMailboxState: vi.fn(),
}));

import { POST } from "@/app/api/portal-inbox-threads/route";

type Tables = { portal_inbox_thread_records: Record<string, unknown>[] };

function seed(roles: string[] = ["manager"]) {
  return createMemoryDb({
    profile_roles: roles.map((role) => ({ user_id: B, role })),
    portal_inbox_thread_records: [],
    audit_log: [],
  });
}

/** Another owner's merged conversation, as a co-manager granted only H1 sees it. */
function pushSharedThread() {
  (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
    id: "msg_inbox_shared",
    scope: MGR,
    owner_user_id: "owner-1",
    participant_email: "tenant@example.test",
    thread_type: null,
    row_data: {
      id: "msg_inbox_shared",
      folder: "inbox",
      unread: true,
      messages: [
        { id: "m1", body: "about house 1", at: "Oct 2", houseId: "H1" },
        { id: "m2", body: "about house 2", at: "Oct 2", houseId: "H2" },
      ],
    },
  });
}
const rows = () => (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records;

async function post(body: unknown) {
  return POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST", body: JSON.stringify(body) }));
}

const forged = (scope: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_inbox_forged_1",
  scope,
  folder: "inbox",
  from: "PropLane Support",
  email: "support@proplane.example",
  participantEmail: "resident-a@example.test",
  ownerUserId: "someone-else",
  subject: "Verify your account",
  body: "Click here",
  ...extra,
});

beforeEach(() => {
  state.viewer = { id: B, email: "b@example.test", role: "manager", name: "Bea Co-Manager" };
  state.seesOtherOwners = false;
  state.grantedHouses = ["H1"];
  state.db = seed();
});

describe("POST /api/portal-inbox-threads - S1 forged threads", () => {
  it("rejects account B writing a resident-scope thread addressed to resident A", async () => {
    const res = await post({ action: "upsert", row: forged(RES) });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("rejects a vendor-scope thread from a manager-only account", async () => {
    const res = await post({ action: "upsert", row: forged(VEN) });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("keeps the admin inbox admin-only", async () => {
    const res = await post({ action: "upsert", row: forged("admin") });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("rejects an unknown scope string", async () => {
    const res = await post({ action: "upsert", row: forged("portal") });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("even a resident-role caller cannot address a thread to someone else: the recipient is their own email", async () => {
    state.db = seed(["manager", "resident"]);
    const res = await post({ action: "upsert", row: forged(RES) });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ owner_user_id: B, participant_email: "b@example.test", scope: RES, thread_type: null });
  });

  it("refuses a replace batch whose later row names a different scope than the first", async () => {
    const res = await post({
      action: "replace",
      rows: [forged(MGR, { id: "msg_ok_1" }), forged(RES, { id: "msg_inbox_forged_2" })],
    });
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("does not let a client mint a deterministic server thread id or a typed thread", async () => {
    await post({ action: "upsert", row: forged(MGR, { id: "agent_notice_victim", threadType: "agent_notice" }) });
    await post({ action: "upsert", row: forged(MGR, { id: "property_mgr_x_y" }) });
    expect(rows()).toHaveLength(0);
    await post({ action: "upsert", row: forged(MGR, { id: "msg_typed_1", threadType: "team" }) });
    expect(rows()[0]).toMatchObject({ thread_type: null });
  });

  it("still saves the caller's own sent copy with no recipient column", async () => {
    const res = await post({
      action: "upsert",
      row: { id: "sent_b_1", scope: MGR, folder: "sent", email: "tenant@example.test", subject: "Hi", body: "Hi" },
    });
    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ owner_user_id: B, participant_email: null, scope: MGR });
  });

  it("an update keeps the stored owner, recipient, scope and type, whatever the body says", async () => {
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "msg_inbox_mine", scope: MGR, owner_user_id: B, participant_email: "b@example.test", thread_type: null,
      row_data: { id: "msg_inbox_mine", folder: "inbox", unread: true },
    });
    const res = await post({
      action: "upsert",
      row: { id: "msg_inbox_mine", scope: MGR, folder: "inbox", participantEmail: "victim@example.test", ownerUserId: "x", threadType: "team", unread: false },
    });
    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ owner_user_id: B, participant_email: "b@example.test", scope: MGR, thread_type: null });
  });

  it("a co-manager's save of another owner's conversation can only ADD turns", async () => {
    // The co-manager was handed a copy with house B's turns removed, so saving
    // it wholesale deleted the owner's turns. Marking it read must not.
    state.seesOtherOwners = true;
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "msg_inbox_shared",
      scope: MGR,
      owner_user_id: "owner-1",
      participant_email: "tenant@example.test",
      thread_type: null,
      row_data: {
        id: "msg_inbox_shared",
        folder: "inbox",
        unread: true,
        messages: [
          { id: "m1", body: "about house 1", at: "Oct 2", houseId: "H1" },
          { id: "m2", body: "about house 2", at: "Oct 2", houseId: "H2" },
        ],
      },
    });
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_shared",
        scope: MGR,
        folder: "inbox",
        unread: false,
        messages: [
          { id: "m1", body: "about house 1", at: "Oct 2", houseId: "H1" },
          { id: "m3", body: "my reply", at: "Oct 3", houseId: "H1", outbound: true, from: "The Owner" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const stored = rows()[0] as {
      owner_user_id: string;
      row_data: { unread: boolean; messages: { id: string; from?: string }[] };
    };
    expect(stored.owner_user_id).toBe("owner-1");
    expect(stored.row_data.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(stored.row_data.unread).toBe(false);
    // The sender a human reads comes from the caller's own profile, not the body.
    expect(stored.row_data.messages.at(-1)?.from).toBe("Bea Co-Manager");
  });

  it("refuses a co-manager inventing an INBOUND turn on another owner's conversation", async () => {
    state.seesOtherOwners = true;
    pushSharedThread();
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_shared",
        scope: MGR,
        folder: "inbox",
        messages: [
          { id: "m1", body: "about house 1", at: "Oct 2", houseId: "H1" },
          { id: "forged", body: "I agreed to this", at: "Oct 3", houseId: "H1", from: "Resident", outbound: false },
        ],
      },
    });
    expect(res.status).toBe(403);
    const stored = rows()[0] as { row_data: { messages: { id: string }[] } };
    expect(stored.row_data.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("refuses a co-manager's turn about a house they were never granted", async () => {
    state.seesOtherOwners = true;
    pushSharedThread();
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_shared",
        scope: MGR,
        folder: "inbox",
        messages: [{ id: "mine", body: "hi", at: "Oct 3", houseId: "H2", outbound: true }],
      },
    });
    expect(res.status).toBe(403);
    expect((rows()[0] as { row_data: { messages: unknown[] } }).row_data.messages).toHaveLength(2);
  });

  it("the OWNER cannot rewrite or delete a stored turn either", async () => {
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "msg_inbox_mine_2", scope: MGR, owner_user_id: B, participant_email: "b@example.test", thread_type: null,
      row_data: {
        id: "msg_inbox_mine_2",
        folder: "inbox",
        unread: true,
        messages: [{ id: "inbound", body: "what the resident actually said", at: "Oct 1" }],
      },
    });
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_mine_2",
        scope: MGR,
        folder: "inbox",
        unread: false,
        messages: [{ id: "inbound", body: "rewritten", at: "Oct 1" }],
      },
    });
    expect(res.status).toBe(200);
    const stored = rows()[0] as { row_data: { unread: boolean; messages: { body: string }[] } };
    expect(stored.row_data.messages).toEqual([{ id: "inbound", body: "what the resident actually said", at: "Oct 1" }]);
    expect(stored.row_data.unread).toBe(false);
  });

  it("clearing the Assistant conversation is its own explicit, audited action", async () => {
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "agent_notice_acct-b", scope: MGR, owner_user_id: B, participant_email: null, thread_type: "agent_notice",
      row_data: { id: "agent_notice_acct-b", folder: "inbox", messages: [{ id: "a1", body: "hi", at: "Oct 1" }] },
    });
    const res = await post({
      action: "clearMessages",
      scope: MGR,
      id: "agent_notice_acct-b",
      placeholder: { preview: "Ask me anything", subject: "PropLane Assistant", from: "PropLane Assistant" },
    });
    expect(res.status).toBe(200);
    const stored = rows()[0] as { row_data: { messages: unknown[]; preview: string } };
    expect(stored.row_data.messages).toEqual([]);
    expect(stored.row_data.preview).toBe("Ask me anything");
    const audit = (state.db as { __tables: Record<string, unknown[]> }).__tables.audit_log ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "inbox_thread_cleared", actor_user_id: B });
  });

  it("will not clear an ordinary person conversation", async () => {
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "msg_inbox_person", scope: MGR, owner_user_id: B, participant_email: "b@example.test", thread_type: null,
      row_data: { id: "msg_inbox_person", folder: "inbox", messages: [{ id: "a1", body: "hi", at: "Oct 1" }] },
    });
    const res = await post({ action: "clearMessages", scope: MGR, id: "msg_inbox_person" });
    expect(res.status).toBe(400);
    expect((rows()[0] as { row_data: { messages: unknown[] } }).row_data.messages).toHaveLength(1);
  });

  it("a resident on a manager-OWNED thread appends as themselves, never as the manager", async () => {
    // The resident reaches this row because they are the person it is with, not
    // because they own it, so the server attributes their turn.
    state.viewer = { id: "res-1", email: "tenant@example.test", role: "resident", name: "Rae Resident" };
    state.db = seed(["resident"]);
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "property_mgr_h1_res1",
      scope: RES,
      owner_user_id: "owner-1",
      participant_email: "tenant@example.test",
      thread_type: "portal_message",
      row_data: {
        id: "property_mgr_h1_res1",
        folder: "inbox",
        propertyId: "H1",
        messages: [{ id: "m1", body: "welcome", at: "Oct 1", outbound: true, from: "Property manager" }],
      },
    });
    const res = await post({
      action: "upsert",
      row: {
        id: "property_mgr_h1_res1",
        scope: RES,
        folder: "inbox",
        messages: [
          { id: "m1", body: "welcome", at: "Oct 1", outbound: true, from: "Property manager" },
          { id: "mine", body: "the sink leaks", at: "Oct 2", outbound: true, from: "Property manager" },
        ],
      },
    });
    expect(res.status).toBe(200);
    const stored = rows()[0] as { row_data: { messages: Record<string, unknown>[] } };
    expect(stored.row_data.messages).toHaveLength(2);
    expect(stored.row_data.messages.at(-1)).toMatchObject({
      body: "the sink leaks",
      from: "Rae Resident",
      outbound: false,
      authorUserId: "res-1",
      houseId: "H1",
    });
  });

  it("a resident cannot delete the manager's turns on that thread", async () => {
    state.viewer = { id: "res-1", email: "tenant@example.test", role: "resident", name: "Rae Resident" };
    state.db = seed(["resident"]);
    (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records.push({
      id: "property_mgr_h1_res1",
      scope: RES,
      owner_user_id: "owner-1",
      participant_email: "tenant@example.test",
      thread_type: "portal_message",
      row_data: {
        id: "property_mgr_h1_res1",
        folder: "inbox",
        messages: [{ id: "m1", body: "welcome", at: "Oct 1" }],
      },
    });
    const res = await post({
      action: "upsert",
      row: { id: "property_mgr_h1_res1", scope: RES, folder: "trash", messages: [] },
    });
    expect(res.status).toBe(200);
    const stored = rows()[0] as { row_data: { messages: { id: string }[]; folder: string } };
    expect(stored.row_data.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(stored.row_data.folder).toBe("trash");
  });

  it("lets an admin write the admin inbox", async () => {
    state.viewer = { id: "adm", email: "adm@example.test", role: "admin", name: "Admin" };
    const res = await post({ action: "upsert", row: { id: "admin_msg_1", scope: "admin", folder: "inbox", email: "x@example.test" } });
    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ scope: "admin", owner_user_id: null });
  });
});
