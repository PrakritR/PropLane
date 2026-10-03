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
  viewer: { id: "", email: "", role: "manager" },
  db: null as unknown,
}));

vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { ...state.viewer }, db: state.db }),
  applyPortalInboxThreadScope: (query: { eq: (col: string, id: string) => unknown }, user: { id: string }) =>
    query.eq("owner_user_id", user.id),
}));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveCommunicationScope: async () => ({ ownerIds: [] }),
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
  state.viewer = { id: B, email: "b@example.test", role: "manager" };
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

  it("lets an admin write the admin inbox", async () => {
    state.viewer = { id: "adm", email: "adm@example.test", role: "admin" };
    const res = await post({ action: "upsert", row: { id: "admin_msg_1", scope: "admin", folder: "inbox", email: "x@example.test" } });
    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ scope: "admin", owner_user_id: null });
  });
});
