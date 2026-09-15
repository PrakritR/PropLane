import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * Manager Communication through the real resolver: the GET route lists only
 * the conversations the viewer may see — per house for a co-manager, per
 * active workspace for everyone, and one PropLane Assistant thread per
 * account. Owner scope in the store query is modeled as the owner filter it
 * is; the house / workspace rule is the real code.
 */

const SCOPE = "axis_portal_inbox_manager_v1";
const A = "owner-a";
const B = "owner-b";
const C = "co-manager-c";
const W1 = "workspace-a-default";
const W2 = "workspace-a-second";
const WC = "workspace-c-default";

const state = vi.hoisted(() => ({
  viewer: { id: "", email: "" },
  cookie: undefined as string | undefined,
  db: null as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined) }),
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { id: state.viewer.id, email: state.viewer.email, role: "manager" }, db: state.db }),
  // The store query's OR clause, modeled as the owner filter it is.
  applyPortalInboxThreadScope: (query: { in: (col: string, ids: string[]) => unknown }, user: { id: string }, extra: string[] = []) =>
    query.in("owner_user_id", [user.id, ...extra]),
}));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({ smsNoticeMembers: vi.fn(async () => []), storedSmsNoticeIdentity: () => false, updateSmsNoticeMailboxState: vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", () => ({
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "business" }) }));

import { GET } from "@/app/api/portal-inbox-threads/route";

const thread = (id: string, owner: string, extra: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) => ({
  id,
  scope: SCOPE,
  owner_user_id: owner,
  participant_email: null,
  thread_type: null,
  updated_at: "2026-09-15T00:00:00.000Z",
  row_data: { id, folder: "inbox", from: id, email: "", subject: id, preview: "", body: "", time: "Sep 15, 9:00 AM", unread: false, ...rowData },
  ...extra,
});

function seed() {
  return createMemoryDb({
    profiles: [
      { id: A, email: "a@example.test", role: "manager" },
      { id: B, email: "b@example.test", role: "manager" },
      { id: C, email: "c@example.test", role: "manager" },
    ],
    portal_workspaces: [
      { id: W1, name: "A default", owner_user_id: A, is_default: true, created_at: "2026-01-01" },
      { id: W2, name: "A second", owner_user_id: A, is_default: false, created_at: "2026-01-02" },
      { id: WC, name: "C default", owner_user_id: C, is_default: true, created_at: "2026-01-03" },
    ],
    manager_property_records: [
      { id: "h1", manager_user_id: A, workspace_id: W1, row_data: { buildingName: "House One" } },
      { id: "h2", manager_user_id: A, workspace_id: W2, row_data: { buildingName: "House Two" } },
      { id: "hc", manager_user_id: C, workspace_id: WC, row_data: { buildingName: "C's House" } },
    ],
    account_link_invites: [
      {
        id: "link-1", status: "accepted", inviter_user_id: A, invitee_user_id: C,
        assigned_property_ids: ["h1"],
        property_co_manager_permissions: { h1: { inbox: { read: true } } },
      },
    ],
    portal_inbox_thread_records: [
      thread("t-h1", A, {}, { propertyId: "h1" }),
      thread("t-h2", A, {}, { propertyId: "h2" }),
      thread("t-untagged", A),
      thread(`agent_notice_${A}`, A, { thread_type: "agent_notice" }),
      // Owner B never invited C, but wrote to C's email: never C's to read.
      thread("t-b", B, { participant_email: "c@example.test" }, { propertyId: "hb" }),
      thread(`agent_notice_${C}`, C, { thread_type: "agent_notice" }),
      thread("t-c", C, {}, { propertyId: "hc" }),
    ],
  });
}

async function listIds(): Promise<string[]> {
  const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { rows: { id: string }[] };
  return body.rows.map((row) => row.id).sort();
}

beforeEach(() => {
  state.db = seed();
  state.cookie = undefined;
});

describe("GET /api/portal-inbox-threads — manager Communication visibility", () => {
  it("shows a co-manager only the granted house's conversations in the shared workspace, plus their own assistant", async () => {
    state.viewer = { id: C, email: "c@example.test" };
    state.cookie = W1;
    expect(await listIds()).toEqual([`agent_notice_${C}`, "t-h1"]);
  });

  it("shows the co-manager nothing of the owner's in their own workspace — and never the uninvited owner's thread", async () => {
    state.viewer = { id: C, email: "c@example.test" };
    state.cookie = WC;
    expect(await listIds()).toEqual([`agent_notice_${C}`, "t-c"]);
    // A workspace the co-manager is not in falls back to their own.
    state.cookie = W2;
    expect(await listIds()).toEqual([`agent_notice_${C}`, "t-c"]);
  });

  it("narrows the owner to the active workspace, keeping untagged conversations in the default one", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    expect(await listIds()).toEqual([`agent_notice_${A}`, "t-h1", "t-untagged"]);
    state.cookie = W2;
    expect(await listIds()).toEqual([`agent_notice_${A}`, "t-h2"]);
  });

  it("labels each listed conversation with the house it is about", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W2;
    const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
    const body = (await response.json()) as { rows: { id: string; houses?: { propertyId: string }[] }[] };
    expect(body.rows.find((row) => row.id === "t-h2")?.houses?.map((h) => h.propertyId)).toEqual(["h2"]);
  });
});
