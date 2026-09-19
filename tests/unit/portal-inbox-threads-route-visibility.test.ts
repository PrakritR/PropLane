import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * Manager Communication through the real resolver: the GET route lists only
 * the conversations the viewer may see — per house for a co-manager, per
 * active workspace for everyone, and one PropLane Assistant thread per
 * manager per workspace. Owner scope in the store query is modeled as the owner filter it
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
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collapseAssistantInboxThreads: (rows: unknown[]) => rows,
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "business" }) }));

import { GET, POST } from "@/app/api/portal-inbox-threads/route";

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
  const body = (await response.json()) as { rows: { id: string }[] };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.rows.map((row) => row.id).sort();
}

beforeEach(() => {
  state.db = seed();
  state.cookie = undefined;
});

describe("GET /api/portal-inbox-threads — manager Communication visibility", () => {
  it("shows a co-manager only the granted house's conversations in the shared workspace", async () => {
    state.viewer = { id: C, email: "c@example.test" };
    state.cookie = W1;
    expect(await listIds()).toEqual(["t-h1"]);
  });

  it("shows the co-manager their own default-workspace assistant at home — and never the uninvited owner's thread", async () => {
    state.viewer = { id: C, email: "c@example.test" };
    state.cookie = WC;
    expect(await listIds()).toEqual([`agent_notice_${C}`, "t-c"]);
    // A workspace the co-manager is not in falls back to their own.
    state.cookie = W2;
    expect(await listIds()).toEqual([`agent_notice_${C}`, "t-c"]);
  });

  it("narrows the owner to the active workspace, keeping the legacy assistant in the default one", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    expect(await listIds()).toEqual([`agent_notice_${A}`, "t-h1", "t-untagged"]);
    state.cookie = W2;
    expect(await listIds()).toEqual(["t-h2"]);
  });

  it("labels each listed conversation with the house it is about", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W2;
    const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
    const body = (await response.json()) as { rows: { id: string; houses?: { propertyId: string }[] }[] };
    expect(body.rows.find((row) => row.id === "t-h2")?.houses?.map((h) => h.propertyId)).toEqual(["h2"]);
  });
});

describe("POST /api/portal-inbox-threads — ordinary upsert relationship ownership", () => {
  it("strips forged identity aliases for new rows and preserves authoritative identity on edits", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    state.db = createMemoryDb({
      portal_inbox_thread_records: [thread("existing-identity", A, {}, {
        managerUserId: "authoritative-manager",
        propertyId: "authoritative-property",
        counterpartyRole: "resident",
        smsConversationKey: "authoritative-key",
        identityProvenance: { source: "server" },
        unread: true,
        folder: "inbox",
        preview: "old preview",
        body: "old body",
        messages: [{ body: "old body" }],
      })],
    });

    const forged = {
      scope: SCOPE,
      id: "new-ordinary-row",
      managerUserId: "forged-manager",
      manager_user_id: "forged-manager-snake",
      propertyId: "forged-property",
      property_id: "forged-property-snake",
      counterpartyRole: "vendor",
      counterparty_role: "vendor",
      smsConversationKey: "forged-key",
      sms_conversation_key: "forged-key-snake",
      identityProvenance: { source: "forged" },
      identity_provenance: { source: "forged-snake" },
      unread: false,
      folder: "inbox",
      preview: "new preview",
      body: "new body",
      messages: [{ body: "new body" }],
    };
    const created = await POST(new Request("https://example.test/api/portal-inbox-threads", {
      method: "POST",
      body: JSON.stringify({ action: "upsert", row: forged }),
      headers: { "content-type": "application/json" },
    }));
    expect(created.status).toBe(200);
    const tables = (state.db as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables;
    const createdRow = tables.portal_inbox_thread_records.find((row) => row.id === "new-ordinary-row");
    expect(createdRow?.owner_user_id).toBe(A);
    expect(createdRow?.row_data).toMatchObject({ unread: false, preview: "new preview", body: "new body" });
    expect(createdRow?.row_data).not.toHaveProperty("managerUserId");
    expect(createdRow?.row_data).not.toHaveProperty("manager_user_id");
    expect(createdRow?.row_data).not.toHaveProperty("propertyId");
    expect(createdRow?.row_data).not.toHaveProperty("property_id");
    expect(createdRow?.row_data).not.toHaveProperty("counterpartyRole");
    expect(createdRow?.row_data).not.toHaveProperty("counterparty_role");
    expect(createdRow?.row_data).not.toHaveProperty("smsConversationKey");
    expect(createdRow?.row_data).not.toHaveProperty("sms_conversation_key");
    expect(createdRow?.row_data).not.toHaveProperty("identityProvenance");
    expect(createdRow?.row_data).not.toHaveProperty("identity_provenance");

    const edited = await POST(new Request("https://example.test/api/portal-inbox-threads", {
      method: "POST",
      body: JSON.stringify({ action: "upsert", row: { ...forged, id: "existing-identity", preview: "edited preview", body: "edited body", messages: [{ body: "edited body" }] } }),
      headers: { "content-type": "application/json" },
    }));
    expect(edited.status).toBe(200);
    const existingRow = tables.portal_inbox_thread_records.find((row) => row.id === "existing-identity");
    expect(existingRow?.row_data).toMatchObject({
      managerUserId: "authoritative-manager",
      propertyId: "authoritative-property",
      counterpartyRole: "resident",
      smsConversationKey: "authoritative-key",
      identityProvenance: { source: "server" },
      unread: false,
      preview: "edited preview",
      body: "edited body",
      messages: [{ body: "edited body" }],
    });
  });
});
