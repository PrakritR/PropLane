import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * QA C1: a resident opening a conversation saves the MERGED row (their own thread
 * folded with a manager-sent notice that has no owner). The save used to hand the
 * owner-less row to the resident, which put a second row on the resident's
 * (owner, workspace, scope, conversation_key) and died on
 * portal_inbox_thread_conversation_uidx (500) - so mark-read never landed. The
 * stored owner now stays, and the folded siblings are settled read in the same call.
 */

const RES = "axis_portal_inbox_resident_v1";
const R = "resident-1";

const state = vi.hoisted(() => ({
  viewer: { id: "", email: "", role: "resident", name: "" },
  db: null as unknown,
}));

vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { ...state.viewer }, db: state.db }),
  applyPortalInboxThreadScope: (query: unknown) => query,
}));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveCommunicationScope: async () => ({ ownerIds: [], grantedHousesByOwner: new Map(), workspaceHouseIds: null }),
  grantedHouseIdsForOwner: () => new Set<string>(),
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
const rows = () => (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records;

const post = (body: unknown) =>
  POST(new Request("https://example.test/api/portal-inbox-threads", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.viewer = { id: R, email: "resident@example.test", role: "resident", name: "Rae Resident" };
  state.db = createMemoryDb({
    profile_roles: [{ user_id: R, role: "resident" }],
    portal_inbox_thread_records: [
      {
        // The manager's notice: addressed by email, no owner yet.
        id: "msg_inbox_notice",
        scope: RES,
        owner_user_id: null,
        participant_email: "resident@example.test",
        thread_type: "portal_message",
        conversation_key: "ws:W1",
        workspace_id: "W1",
        row_data: { id: "msg_inbox_notice", folder: "inbox", unread: true, body: "Charge created", messages: [] },
      },
      {
        // The resident's own thread in the same conversation.
        id: "msg_f4290f7c",
        scope: RES,
        owner_user_id: R,
        participant_email: null,
        thread_type: null,
        conversation_key: "ws:W1",
        workspace_id: "W1",
        row_data: { id: "msg_f4290f7c", folder: "sent", unread: true, body: "Hi", messages: [] },
      },
    ],
    audit_log: [],
  });
});

describe("resident saves a merged conversation", () => {
  it("leaves an owner-less row owner-less (never claims it for the caller)", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_notice",
        scope: RES,
        folder: "inbox",
        unread: false,
        conversationKey: "ws:W1",
        sourceThreadIds: ["msg_inbox_notice", "msg_f4290f7c"],
      },
    });
    expect(res.status).toBe(200);
    const saved = rows().find((row) => row.id === "msg_inbox_notice")!;
    expect(saved.owner_user_id).toBeNull();
    expect((saved.row_data as { unread: boolean }).unread).toBe(false);
    // The index columns are not the client's to write.
    expect(saved.conversation_key).toBe("ws:W1");
    expect(rows()).toHaveLength(2);
  });

  it("settles the folded sibling read too, so the badge does not come back", async () => {
    const res = await post({
      action: "upsert",
      row: {
        id: "msg_inbox_notice",
        scope: RES,
        folder: "inbox",
        unread: false,
        sourceThreadIds: ["msg_inbox_notice", "msg_f4290f7c"],
      },
    });
    expect(res.status).toBe(200);
    const sibling = rows().find((row) => row.id === "msg_f4290f7c")!;
    expect((sibling.row_data as { unread: boolean }).unread).toBe(false);
  });

  it("does not mark a sibling read when the save leaves the conversation unread", async () => {
    await post({
      action: "upsert",
      row: { id: "msg_inbox_notice", scope: RES, folder: "inbox", unread: true, sourceThreadIds: ["msg_inbox_notice", "msg_f4290f7c"] },
    });
    const sibling = rows().find((row) => row.id === "msg_f4290f7c")!;
    expect((sibling.row_data as { unread: boolean }).unread).toBe(true);
  });
});
