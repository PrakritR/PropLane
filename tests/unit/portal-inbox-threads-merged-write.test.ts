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
        updated_at: "2026-10-16T00:00:00.000Z",
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
        updated_at: "2026-10-16T00:00:00.000Z",
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

  it("never rolls a sibling's history back to the copy the read-settle saw", async () => {
    // `row_data` is one jsonb column: writing it back whole from the read above would drop
    // a turn an inbound delivery appended in between. The flip is a compare-and-set, so a
    // stale write lands on nothing and re-reads on top of the newer copy.
    const sibling = rows().find((row) => row.id === "msg_f4290f7c")! as Record<string, unknown>;
    const deliverConcurrently = () => {
      sibling.row_data = {
        ...(sibling.row_data as Record<string, unknown>),
        messages: [{ id: "inbound-1", body: "Sent while you were reading" }],
      };
      sibling.updated_at = "2026-10-16T00:00:05.000Z";
    };
    // The route reads the siblings, then writes each one: land the append in that window.
    const db = state.db as { from: (table: string) => unknown };
    const original = db.from.bind(db);
    let reads = 0;
    (state.db as { from: (table: string) => unknown }).from = (table: string) => {
      const builder = original(table) as Record<string, unknown> & { select?: (...a: unknown[]) => unknown };
      if (table === "portal_inbox_thread_records") {
        const select = builder.select as (...a: unknown[]) => unknown;
        builder.select = (...args: unknown[]) => {
          const next = select.apply(builder, args);
          if (String(args[0] ?? "").includes("updated_at") && reads++ === 0) deliverConcurrently();
          return next;
        };
      }
      return builder;
    };

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
    const settled = rows().find((row) => row.id === "msg_f4290f7c")! as { row_data: Record<string, unknown> };
    expect(settled.row_data.unread).toBe(false);
    expect(settled.row_data.messages).toEqual([{ id: "inbound-1", body: "Sent while you were reading" }]);
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
