/**
 * EVIDENCE HARNESS — the communication fixes of the Oct 16 sweep, at the API boundary.
 *
 * Drives the REAL `/api/portal-inbox-threads` handler and the REAL reply commit over an
 * in-memory Supabase, and writes a transcript to EVIDENCE_DIR showing the rows before and
 * after each call:
 *
 *   A. A resident opens a MERGED conversation. Before the fix the save handed the
 *      owner-less manager notice to the resident, hit
 *      `portal_inbox_thread_conversation_uidx` and 500'd — so mark-read never landed and
 *      the badge came straight back. Now: HTTP 200, the owner-less row stays owner-less,
 *      and the folded sibling is settled read in the same call.
 *   B. A reply is ONE message end to end: the id the composer showed is the id the server
 *      stores, however many channels commit it, and the pending AI draft it answered is
 *      cleared (so the composer does not re-offer it after an outbound turn).
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-inbox-1016.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryDb } from "./support/memory-supabase";

const RES = "axis_portal_inbox_resident_v1";
const MGR = "axis_portal_inbox_manager_v1";
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
import { commitInboxThreadReply, type InboxThreadReplyTarget } from "@/lib/portal-inbox-delivery";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
const say = (line: string) => transcript.push(line);
const block = (label: string, value: unknown) => say(`${label}\n${JSON.stringify(value, null, 2)}\n`);

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "inbox-api-transcript.txt"), transcript.join("\n"), "utf8");
});

type Tables = { portal_inbox_thread_records: Record<string, unknown>[] };
const rows = () => (state.db as { __tables: Tables }).__tables.portal_inbox_thread_records;
const readable = () =>
  rows().map((row) => ({
    id: row.id,
    owner_user_id: row.owner_user_id,
    participant_email: row.participant_email,
    conversation_key: row.conversation_key,
    folder: (row.row_data as { folder?: string }).folder,
    unread: (row.row_data as { unread?: boolean }).unread,
  }));

beforeEach(() => {
  state.viewer = { id: R, email: "resident@example.test", role: "resident", name: "Rae Resident" };
  state.db = createMemoryDb({
    profile_roles: [{ user_id: R, role: "resident" }],
    portal_inbox_thread_records: [
      {
        // The manager's automated notice: addressed by email, no owner yet.
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
        // The resident's own thread in the same conversation — what the list folds together.
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

describe("opening a merged conversation marks it read", () => {
  it("answers 200 and settles both folded rows, leaving the owner-less one owner-less", async () => {
    say("================================================================");
    say("A. MARK-READ ON A MERGED CONVERSATION — POST /api/portal-inbox-threads");
    say("================================================================");
    say("Viewer: Rae Resident (resident-1). The list folds two rows into one conversation.");
    block("portal_inbox_thread_records BEFORE:", readable());

    const res = await POST(
      new Request("https://example.test/api/portal-inbox-threads", {
        method: "POST",
        body: JSON.stringify({
          action: "upsert",
          row: {
            id: "msg_inbox_notice",
            scope: RES,
            folder: "inbox",
            unread: false,
            conversationKey: "ws:W1",
            sourceThreadIds: ["msg_inbox_notice", "msg_f4290f7c"],
          },
        }),
      }),
    );
    say(`HTTP ${res.status}   (this call used to 500 on portal_inbox_thread_conversation_uidx)\n`);
    expect(res.status).toBe(200);

    block("portal_inbox_thread_records AFTER:", readable());
    const notice = rows().find((row) => row.id === "msg_inbox_notice")!;
    const sibling = rows().find((row) => row.id === "msg_f4290f7c")!;
    expect(notice.owner_user_id).toBeNull();
    expect((notice.row_data as { unread: boolean }).unread).toBe(false);
    expect((sibling.row_data as { unread: boolean }).unread).toBe(false);
    expect(rows()).toHaveLength(2);
    say("Both folded rows are read, no third row was minted, and the notice is still");
    say("owner-less — so the unread badge and the list agree after one open.\n");
  });
});

describe("a reply is one message end to end", () => {
  it("stores the composer's id once and clears the AI draft it answered", async () => {
    const db = createMemoryDb({
      portal_inbox_thread_records: [
        {
          id: "t1",
          scope: MGR,
          owner_user_id: "mgr-1",
          participant_email: null,
          row_data: {
            id: "t1",
            folder: "inbox",
            unread: true,
            body: "Is the sink fixed?",
            messages: [],
            aiDraft: { text: "Yes, it is fixed.", status: "pending_approval", generatedAt: "g1" },
          },
        },
      ],
    });
    const target = { threadId: "t1", scope: MGR, ownerUserId: "mgr-1", participantEmail: null } as unknown as InboxThreadReplyTarget;
    const stored = () => db.__tables.portal_inbox_thread_records![0]!.row_data as Record<string, unknown>;

    say("================================================================");
    say("B. ONE REPLY, ONE ID — commitInboxThreadReply");
    say("================================================================");
    block("Thread BEFORE (an AI draft is pending on it):", stored());

    const opts = { fromName: "Test Manager", text: "It is fixed.", messageId: "reply-abc12" };
    // The same reply, committed twice — the composer's optimistic turn and the channel's.
    await commitInboxThreadReply(db as never, target, opts);
    await commitInboxThreadReply(db as never, target, opts);

    block("Thread AFTER two commits of the same reply:", stored());
    const messages = stored().messages as { id: string }[];
    expect(messages.map((m) => m.id)).toEqual(["reply-abc12"]);
    expect(stored().aiDraft).toBeUndefined();
    say("One stored turn under the composer's own id (no duplicate under a second name),");
    say("and the pending AI draft is gone, so it is not re-offered after an outbound turn.");
  });
});
