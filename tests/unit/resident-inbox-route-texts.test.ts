import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationFakeDb, type FakeDb } from "../helpers/conversation-fake-db";

/**
 * C1-R4 at the route: GET /api/portal-inbox-threads?scope=resident returns the
 * resident's stored conversation with the manager's identity and the texts that
 * are theirs folded in; an unverified phone adds none and says so.
 */

const SCOPE = "axis_portal_inbox_resident_v1";
const M = "11111111-0000-4000-8000-00000000000a";
const R = "22222222-0000-4000-8000-00000000000b";
const W = "aaaaaaaa-0000-4000-8000-0000000000a1";
const LINE = "bbbbbbbb-0000-4000-8000-0000000000b1";
const PHONE = "+14233423444";

const state = vi.hoisted(() => ({ db: null as unknown, role: "resident" }));

vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { id: R, email: "resident@x.co", role: state.role, name: "Rita Resident" }, db: state.db }),
  applyPortalInboxThreadScope: (query: { eq: (col: string, value: string) => unknown }) => query.eq("owner_user_id", R),
}));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/sms-inbox-state.server", () => ({ smsNoticeMembers: vi.fn(async () => []), storedSmsNoticeIdentity: () => false, updateSmsNoticeMailboxState: vi.fn() }));

import { GET } from "@/app/api/portal-inbox-threads/route";

function seed(verified: boolean): FakeDb {
  return createConversationFakeDb({
    profiles: [
      { id: M, email: "m@x.co", full_name: "Maya Manager" },
      { id: R, email: "resident@x.co", full_name: "Rita Resident", phone: PHONE, phone_verified_at: verified ? "2026-10-01T00:00:00Z" : null },
    ],
    profile_roles: [{ user_id: R, role: "resident" }],
    portal_workspaces: [{ id: W, owner_user_id: M, name: "Maya Homes", is_default: true }],
    manager_sms_numbers: [{ id: LINE, workspace_id: W, manager_user_id: M, phone_number: "+12065550101", provision_state: "active" }],
    portal_inbox_thread_records: [
      {
        id: "t-1",
        scope: SCOPE,
        owner_user_id: R,
        participant_email: "resident@x.co",
        thread_type: null,
        updated_at: "2026-10-02T00:00:00Z",
        row_data: {
          id: "t-1", folder: "inbox", from: "Maya Manager", email: "m@x.co", subject: "Welcome", preview: "Welcome",
          body: "Welcome", time: "Oct 2, 2026, 9:00 AM", rootAt: "Oct 2, 2026, 9:00 AM", unread: false,
          conversationKey: `ws:${W}`, workspaceId: W,
          // A forged claim in the stored row must never survive.
          counterparty: { name: "Forged" }, smsOnly: true,
        },
      },
    ],
    sms_projection_conversations: [
      { id: "conv-1", owner_manager_user_id: M, counterparty_role: "prospect", work_line_id: LINE, counterparty_user_id: null, counterparty_phone: PHONE, workspace_id: W, merged_into_id: null },
    ],
    sms_projection_turns: [
      { id: "turn-1", conversation_id: "conv-1", direction: "inbound", body: "texting from 4233423444", occurred_at: "2026-10-02T18:00:00Z", from_phone: PHONE, to_phone: "+12065550101" },
    ],
  });
}

const call = async () => {
  const response = await GET(new Request(`http://localhost/api/portal-inbox-threads?scope=${SCOPE}`));
  return (await response.json()) as { rows: { id: string; counterparty?: { name: string; workPhone: string }; smsOnly?: boolean; messages?: { body: string; channel?: string }[] }[]; residentPhone?: unknown };
};

describe("GET /api/portal-inbox-threads (resident scope) carries the manager and the texts", () => {
  beforeEach(() => {
    state.role = "resident";
  });

  it("a verified phone: the text sits in the same conversation as the in-app row, naming the manager", async () => {
    state.db = seed(true);
    const body = await call();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.id).toBe("t-1");
    expect(body.rows[0]!.counterparty).toMatchObject({ name: "Maya Manager", workPhone: "+12065550101" });
    expect(body.rows[0]!.smsOnly).toBeUndefined();
    expect(body.rows[0]!.messages?.some((m) => m.channel === "sms" && m.body === "texting from 4233423444")).toBe(true);
    expect(body.residentPhone).toEqual({ hasPhone: true, verified: true, ambiguous: false });
  });

  it("an unverified phone: the stored conversation lists, the text does not, and the phone state says verify", async () => {
    state.db = seed(false);
    const body = await call();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.messages?.some((m) => m.channel === "sms") ?? false).toBe(false);
    expect(body.residentPhone).toEqual({ hasPhone: true, verified: false, ambiguous: false });
  });

  it("with no stored row the verified texts are still a conversation of their own, read-only", async () => {
    const db = seed(true);
    db.tables.portal_inbox_thread_records = [];
    state.db = db;
    const body = await call();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: `resident_sms_${W}`, smsOnly: true, counterparty: { name: "Maya Manager" } });
  });
});
