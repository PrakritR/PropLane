import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * Workspace isolation in manager Communication, through the real route and resolver:
 *  - a conversation stamped with another workspace is never listed in this one;
 *  - deleting an empty chat is saved server-side (`dismissContacts`), pinned to the signed-in
 *    viewer and the workspace the server resolves — never to ids in the body — and survives a reload.
 */

const SCOPE = "axis_portal_inbox_manager_v1";
const A = "owner-a";
const B = "owner-b";
const W1 = "workspace-a-default";
const W2 = "workspace-a-second";
const WB = "workspace-b-default";

const state = vi.hoisted(() => ({
  viewer: { id: "", email: "" },
  cookie: undefined as string | undefined,
  db: null as unknown,
  viewAs: false,
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
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => state.viewAs }));
const ensureNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: ensureNotice }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({ smsNoticeMembers: vi.fn(async () => []), storedSmsNoticeIdentity: () => false, updateSmsNoticeMailboxState: vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", () => ({
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
    ],
    portal_workspaces: [
      { id: W1, name: "A default", owner_user_id: A, is_default: true, created_at: "2026-01-01" },
      { id: W2, name: "A second", owner_user_id: A, is_default: false, created_at: "2026-01-02" },
      { id: WB, name: "B default", owner_user_id: B, is_default: true, created_at: "2026-01-03" },
    ],
    manager_property_records: [
      { id: "h1", manager_user_id: A, workspace_id: W1, row_data: { buildingName: "House One" } },
      { id: "h2", manager_user_id: A, workspace_id: W2, row_data: { buildingName: "House Two" } },
    ],
    account_link_invites: [],
    communication_dismissed_contacts: [],
    portal_inbox_thread_records: [
      thread("t-h1", A, {}, { propertyId: "h1" }),
      // About a W1 house but stamped with W2: it belongs to W2 alone.
      thread("t-stamped-w2", A, { workspace_id: W2 }, { propertyId: "h1" }),
      thread("t-stamped-w2-own-house", A, { workspace_id: W2 }, { propertyId: "h2" }),
      thread("t-stamped-w1", A, { workspace_id: W1 }, { propertyId: "h1" }),
      thread("t-h2-unstamped", A, {}, { propertyId: "h2" }),
      thread("t-h2-stamped-w1", A, { workspace_id: W1 }, { propertyId: "h2" }),
    ],
  });
}

async function listIds(): Promise<string[]> {
  const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}`));
  expect(response.status).toBe(200);
  return ((await response.json()) as { rows: { id: string }[] }).rows.map((row) => row.id).sort();
}

async function dismissed(): Promise<string[]> {
  const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${SCOPE}&view=dismissed&workspaceId=ignored`));
  expect(response.status).toBe(200);
  return ((await response.json()) as { dismissed: string[] }).dismissed.sort();
}

function post(body: Record<string, unknown>) {
  return POST(new Request("https://example.test/api/portal-inbox-threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: SCOPE, ...body }),
  }));
}

beforeEach(() => {
  state.db = seed();
  state.cookie = undefined;
  state.viewAs = false;
  ensureNotice.mockClear();
});

describe("a conversation stamped with a workspace shows only there", () => {
  it("hides a thread stamped with another workspace even when its house is in this one", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    const ids = await listIds();
    expect(ids).toContain("t-h1");
    expect(ids).toContain("t-stamped-w1");
    expect(ids).not.toContain("t-stamped-w2");
  });

  it("shows the other workspace its own stamped thread, and keeps an unstamped one following its house", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W2;
    const ids = await listIds();
    expect(ids).toContain("t-stamped-w2-own-house");
    expect(ids).toContain("t-h2-unstamped");
    expect(ids).not.toContain("t-stamped-w1");
    expect(ids).not.toContain("t-h2-stamped-w1");
  });
});

describe("POST /api/portal-inbox-threads dismissContacts", () => {
  it("saves the dismissal for the signed-in viewer in the server-resolved workspace", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    const res = await post({ action: "dismissContacts", contactKeys: ["Khue@Example.test", "khue@example.test", "not-an-email"] });
    expect(res.status).toBe(200);
    expect(await dismissed()).toEqual(["khue@example.test"]);
    const stored = await (state.db as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: Record<string, unknown>[] }> } })
      .from("communication_dismissed_contacts")
      .select("*");
    expect(stored.data).toHaveLength(1);
    expect(stored.data[0]).toMatchObject({ viewer_user_id: A, workspace_id: W1, contact_key: "khue@example.test" });
  });

  it("ignores a workspace or viewer named in the body", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    const res = await post({
      action: "dismissContacts",
      contactKeys: ["khue@example.test"],
      workspaceId: W2,
      workspace_id: W2,
      viewerUserId: B,
      viewer_user_id: B,
    });
    expect(res.status).toBe(200);
    // Listed under the cookie's workspace (W1) for the real viewer…
    expect(await dismissed()).toEqual(["khue@example.test"]);
    // …and not under the workspace the body named.
    state.cookie = W2;
    expect(await dismissed()).toEqual([]);
    // …nor for the viewer the body named.
    state.viewer = { id: B, email: "b@example.test" };
    state.cookie = WB;
    expect(await dismissed()).toEqual([]);
  });

  it("stays dismissed across reloads, and is per workspace", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    await post({ action: "dismissContacts", contactKeys: ["khue@example.test"] });
    expect(await dismissed()).toEqual(["khue@example.test"]);
    expect(await dismissed()).toEqual(["khue@example.test"]);
    state.cookie = W2;
    expect(await dismissed()).toEqual([]);
  });

  it("clearDismissedContacts brings the person back", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    await post({ action: "dismissContacts", contactKeys: ["khue@example.test", "vivek@example.test"] });
    const res = await post({ action: "clearDismissedContacts", contactKeys: ["khue@example.test"] });
    expect(res.status).toBe(200);
    expect(await dismissed()).toEqual(["vivek@example.test"]);
  });

  it("refuses an empty or non-manager request", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    expect((await post({ action: "dismissContacts", contactKeys: [] })).status).toBe(400);
    expect((await post({ action: "dismissContacts", scope: "axis_portal_inbox_resident_v1", contactKeys: ["a@example.test"] })).status).toBe(400);
  });

  it("does not hide a live conversation: the dismissal read is a list of people, not of threads", async () => {
    state.viewer = { id: A, email: "a@example.test" };
    state.cookie = W1;
    await post({ action: "dismissContacts", contactKeys: ["t-h1@example.test"] });
    expect(await listIds()).toContain("t-h1");
  });
});
