// @vitest-environment jsdom
/**
 * EVIDENCE — your own conversation stamped with the open workspace shows in that workspace.
 *
 * Drives the REAL `GET /api/portal-inbox-threads` (real `resolveCommunicationScope` +
 * `filterVisibleInboxThreadRecords`) over an in-memory Supabase, then renders the REAL manager
 * Communication list (`ManagerUnifiedInbox`) over exactly the rows that read returned, and writes
 * each state to `$EVIDENCE_DIR` as HTML a reviewer can open or screenshot.
 *
 * The manager owns two workspaces. "Brooklyn Houses" is the DEFAULT; "Capitol Hill" is not.
 * Three stored conversations, all untagged (about no house):
 *
 *   - Dana Reyes   — the manager's own, stamped `workspace_id = ws-capitol` by the store at send
 *   - Marco Silva  — the manager's own, stamped `workspace_id = ws-brooklyn` (the default)
 *   - Priya Raman  — ANOTHER owner's row (Ambika), stamped `ws-capitol`, on a house the viewer
 *                    holds an accepted inbox grant for. It must never appear in the viewer's
 *                    workspace: the stamp shortcut is for your OWN row only.
 *
 * Before this change Dana's row was invisible everywhere: untagged rows only read in the default
 * workspace, and the stamp refuses every workspace but ws-capitol.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-workspace-stamp-inbox-1117.test.tsx
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { WorkspacePayload } from "@/lib/workspaces/types";
import { createMemoryDb } from "./support/memory-supabase";

const OUT = process.env.EVIDENCE_DIR ?? join(tmpdir(), "proplane-workspace-stamp-evidence");

const MGR = "axis_portal_inbox_manager_v1";
const PRAKRIT = "owner-prakrit";
const AMBIKA = "owner-ambika";
const BROOKLYN_WS = "ws-brooklyn";
const CAPITOL_WS = "ws-capitol";
const BROOKLYN_HOUSE = "house-brooklyn-5257";
const CAPITOL_HOUSE = "house-capitol-114";
const SEATTLE_HOUSE = "house-seattle-homes";

const state = vi.hoisted(() => ({
  viewer: { id: "", email: "", role: "manager", name: "Prakrit Ramachandran" },
  cookie: undefined as string | undefined,
  db: null as unknown,
}));

// ---- the client-side sources the contact directory is built from ----------------------------
vi.mock("@/lib/manager-applications-storage", () => ({
  readManagerApplicationRows: () => [],
  syncManagerApplicationsFromServerWithStatus: async () => ({ ok: true }),
}));
vi.mock("@/lib/portal-data-store", () => ({ readCachedAccountLinkInvites: () => [] }));
vi.mock("@/lib/pro-relationships", () => ({ readProRelationships: () => [] }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  readOwnActiveManagerVendorRows: () => [],
  isVendorCategorySettingsRow: () => false,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: state.viewer.id, email: state.viewer.email, ready: true }),
}));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));

// ---- the server side: the real route over an in-memory database ------------------------------
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined),
  }),
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({ user: { ...state.viewer }, db: state.db }),
  applyPortalInboxThreadScope: (q: { in: (c: string, ids: string[]) => unknown }, user: { id: string }, extra: string[] = []) =>
    q.in("owner_user_id", [user.id, ...extra]),
}));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/agent-notify.server", () => ({ ensureManagerAgentNoticeThread: vi.fn() }));
vi.mock("@/lib/agent/resident-inbox-agent.server", () => ({ ensureResidentAgentThread: vi.fn() }));
vi.mock("@/lib/resident-manager-scope", () => ({ managerIdsOwningResident: vi.fn(async () => []) }));
vi.mock("@/lib/sms-inbox-state.server", () => ({
  smsNoticeMembers: vi.fn(async () => []),
  storedSmsNoticeIdentity: () => false,
  updateSmsNoticeMailboxState: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "business" }) }));
vi.mock("@/components/providers/app-ui-provider", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfirm: () => async () => true,
  useToast: () => () => {},
}));

import { GET } from "@/app/api/portal-inbox-threads/route";
import { resolveCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { inboxStoreOwnerIds } from "@/lib/communication/inbox-store-owner-ids";
import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { EMPTY_COMMUNICATION_THREAD_FILTERS } from "@/lib/communication-thread-filters";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";

function installFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const absolute = url.startsWith("http") ? url : `https://example.test${url}`;
    if (absolute.includes("/api/portal-inbox-threads")) {
      return GET(new Request(absolute, init as RequestInit));
    }
    return new Response(JSON.stringify({ residents: [], conversations: [], rows: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** One stored, UNTAGGED conversation (no house anywhere in its row), as the store keeps it. */
function storedThread(args: {
  id: string;
  owner: string;
  name: string;
  email: string;
  body: string;
  workspaceId: string;
  updatedAt: string;
}) {
  return {
    id: args.id,
    scope: MGR,
    owner_user_id: args.owner,
    participant_email: args.email,
    thread_type: "portal_message",
    conversation_key: `acct:${args.email}`,
    workspace_id: args.workspaceId,
    updated_at: args.updatedAt,
    row_data: {
      id: args.id,
      folder: "inbox",
      from: args.name,
      email: args.email,
      subject: "",
      preview: args.body,
      body: args.body,
      time: "Nov 17, 9:14 AM",
      unread: false,
      messages: [],
    },
  };
}

/** The payload the Communication page loads: the real GET for the workspace in the cookie. */
async function readInbox(workspaceId: string): Promise<{ rows: PersistedInboxThread[]; raw: unknown }> {
  state.cookie = workspaceId;
  const response = await GET(new Request(`https://example.test/api/portal-inbox-threads?scope=${MGR}`));
  const json = (await response.json()) as { rows?: PersistedInboxThread[] };
  expect(response.status).toBe(200);
  return { rows: json.rows ?? [], raw: json };
}

function workspace(id: string, name: string, isDefault: boolean, propertyIds: string[]) {
  return {
    id,
    name,
    ownerUserId: PRAKRIT,
    owned: true,
    isDefault,
    propertyIds,
    propertyPermissions: {},
  } as unknown as WorkspacePayload["workspaces"][number];
}

function adapterFor(threads: PersistedInboxThread[]): CommunicationInboxAdapter {
  return {
    kind: "manager",
    storageKey: "evidence-workspace-stamp",
    threadsChangedEvent: "evidence-workspace-stamp-changed",
    loadCachedThreads: () => threads,
    stageThreads: () => {},
    syncThreads: async () => ({ ok: true, rows: threads }) as never,
    buildListThreads: (rows) => rows,
    pinsAssistant: false,
    directChat: true,
    loadSmsConversations: async () =>
      new Response(JSON.stringify({ residents: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
    invalidateSmsConversations: () => {},
    smsArchivable: true,
    identityBoxes: null,
  };
}

let current: HTMLElement | null = null;

async function renderInbox(threads: PersistedInboxThread[]) {
  const view = render(
    <div style={{ width: "460px" }}>
      <ManagerUnifiedInbox
        tabId="communication"
        commBase="/portal/communication"
        listSegment="active"
        threadFilters={EMPTY_COMMUNICATION_THREAD_FILTERS}
        filterContacts={[]}
        adapter={adapterFor(threads)}
      />
    </div>,
  );
  await waitFor(() => expect(document.querySelector("[data-communication-inbox-list]")).toBeTruthy());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  current = view.container;
  return view;
}

function rowNames(): string[] {
  return [...(current ?? document.body).querySelectorAll(".portal-inbox-row")].map((row) =>
    (row.querySelector("p span")?.textContent ?? "").trim(),
  );
}

const panels: { id: string; caption: string; note: string; html: string }[] = [];
const transcript: string[] = [];
const say = (line: string) => transcript.push(line);

function capture(id: string, caption: string, note: string) {
  const pane = (current ?? document.body).querySelector("[data-communication-inbox-list]")?.parentElement;
  panels.push({ id, caption, note, html: (pane ?? current ?? document.body).innerHTML });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/portal/communication");
  state.viewer = { id: PRAKRIT, email: "prakrit@example.test", role: "manager", name: "Prakrit Ramachandran" };
  state.cookie = BROOKLYN_WS;
  state.db = createMemoryDb({
    profiles: [
      { id: PRAKRIT, email: "prakrit@example.test", role: "manager" },
      { id: AMBIKA, email: "ambika@example.test", role: "manager" },
    ],
    profile_roles: [
      { user_id: PRAKRIT, role: "manager" },
      { user_id: AMBIKA, role: "manager" },
    ],
    portal_workspaces: [
      { id: BROOKLYN_WS, name: "Brooklyn Houses", owner_user_id: PRAKRIT, is_default: true, is_service: false, created_at: "2026-01-01" },
      { id: CAPITOL_WS, name: "Capitol Hill", owner_user_id: PRAKRIT, is_default: false, is_service: false, created_at: "2026-02-01" },
      { id: "ws-seattle", name: "SEATTLE HOMES", owner_user_id: AMBIKA, is_default: true, is_service: false, created_at: "2026-01-05" },
    ],
    manager_property_records: [
      { id: BROOKLYN_HOUSE, manager_user_id: PRAKRIT, workspace_id: BROOKLYN_WS, status: "live", row_data: { buildingName: "5257 Brooklyn Ave NE" } },
      { id: CAPITOL_HOUSE, manager_user_id: PRAKRIT, workspace_id: CAPITOL_WS, status: "live", row_data: { buildingName: "114 Capitol Hill" } },
      { id: SEATTLE_HOUSE, manager_user_id: AMBIKA, workspace_id: "ws-seattle", status: "live", row_data: { buildingName: "SEATTLE HOMES" } },
    ],
    // The viewer really does co-manage one of Ambika's houses, with Communication read.
    account_link_invites: [
      {
        id: "link-1",
        inviter_user_id: AMBIKA,
        invitee_user_id: PRAKRIT,
        status: "accepted",
        workspace_id: "ws-seattle",
        team_role: "property_manager",
        assigned_property_ids: [SEATTLE_HOUSE],
        property_co_manager_permissions: { [SEATTLE_HOUSE]: { inbox: true } },
      },
    ],
    portal_inbox_thread_records: [
      storedThread({
        id: "msg_dana_capitol",
        owner: PRAKRIT,
        name: "Dana Reyes",
        email: "dana@example.test",
        body: "Thanks — I'll take the Capitol Hill room.",
        workspaceId: CAPITOL_WS,
        updatedAt: "2026-11-17T17:14:00.000Z",
      }),
      storedThread({
        id: "msg_marco_brooklyn",
        owner: PRAKRIT,
        name: "Marco Silva",
        email: "marco@example.test",
        body: "Is the Brooklyn place still open?",
        workspaceId: BROOKLYN_WS,
        updatedAt: "2026-11-17T16:02:00.000Z",
      }),
      storedThread({
        id: "msg_priya_other_owner",
        owner: AMBIKA,
        name: "Priya Raman",
        email: "priya@example.test",
        body: "Ambika's own conversation, stamped with Prakrit's workspace.",
        workspaceId: CAPITOL_WS,
        updatedAt: "2026-11-17T15:40:00.000Z",
      }),
    ],
    communication_dismissed_contacts: [],
    sms_projection_cutover: [],
  });
  setWorkspaceSelection(null);
  installFetch();
});

afterEach(() => {
  cleanup();
  current = null;
});

afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "workspace-stamp-panels.json"), JSON.stringify(panels, null, 2));
  writeFileSync(join(OUT, "workspace-stamp-api-transcript.txt"), transcript.join("\n"), "utf8");
});

describe("evidence: a workspace stamp places the manager's own untagged conversation", () => {
  it("Capitol Hill (not the default workspace) lists the conversation stamped with it", async () => {
    const { rows } = await readInbox(CAPITOL_WS);
    say("================================================================");
    say("GET /api/portal-inbox-threads?scope=manager   cookie proplane-workspace=ws-capitol");
    say('   (Capitol Hill: the manager\'s own workspace, is_default = false)');
    say("================================================================");
    say(JSON.stringify(rows.map((row) => ({ id: row.id, from: row.from, preview: row.preview })), null, 2));
    say("");

    // Captured BEFORE the assertions on purpose: run this same file against the previous commit
    // and the panel written out is the empty Communication list the manager actually saw.
    setWorkspaceSelection({ workspaces: [workspace(CAPITOL_WS, "Capitol Hill", false, [CAPITOL_HOUSE])], activeWorkspaceId: CAPITOL_WS });
    await renderInbox(rows);
    capture(
      "01-capitol-hill-shows-stamped-row",
      "Capitol Hill (NOT the default workspace) — Communication",
      "The manager's own untagged conversation, stamped ws-capitol at send, is listed here. Before this change the row was hidden in every workspace.",
    );

    expect(rows.map((row) => row.id)).toEqual(["msg_dana_capitol"]);
    expect(rowNames()).toEqual(["Dana Reyes"]);
    expect(document.body.textContent).toContain("I'll take the Capitol Hill room");
  });

  it("the default workspace still lists only its own row, not the Capitol Hill one", async () => {
    const { rows } = await readInbox(BROOKLYN_WS);
    say("================================================================");
    say("GET /api/portal-inbox-threads?scope=manager   cookie proplane-workspace=ws-brooklyn");
    say("   (Brooklyn Houses: the manager's DEFAULT workspace)");
    say("================================================================");
    say(JSON.stringify(rows.map((row) => ({ id: row.id, from: row.from, preview: row.preview })), null, 2));
    say("");

    expect(rows.map((row) => row.id)).toEqual(["msg_marco_brooklyn"]);

    setWorkspaceSelection({ workspaces: [workspace(BROOKLYN_WS, "Brooklyn Houses", true, [BROOKLYN_HOUSE])], activeWorkspaceId: BROOKLYN_WS });
    await renderInbox(rows);
    expect(rowNames()).toEqual(["Marco Silva"]);
    capture(
      "02-default-workspace-unchanged",
      "Brooklyn Houses (the default workspace) — Communication",
      "Narrowing never widened: the conversation stamped with Capitol Hill does not appear here, and the default workspace's own untagged row still does.",
    );
  });

  it("never lists another owner's row stamped with the open workspace", async () => {
    // The grant is real, so Ambika's row is genuinely fetched by the store query before the
    // visibility rule decides — without this the check below would prove nothing.
    state.cookie = CAPITOL_WS;
    const scope = await resolveCommunicationScope(state.db as never, PRAKRIT, "read");
    expect(inboxStoreOwnerIds(scope)).toContain(AMBIKA);
    expect([...(scope.grantedHousesByOwner.get(AMBIKA) ?? [])]).toEqual([SEATTLE_HOUSE]);
    expect(scope.activeWorkspaceId).toBe(CAPITOL_WS);
    expect(scope.untaggedOwnedVisible).toBe(false);

    const { rows: capitol } = await readInbox(CAPITOL_WS);
    const { rows: brooklyn } = await readInbox(BROOKLYN_WS);
    say("================================================================");
    say("Another owner's row (Ambika's), stamped ws-capitol, viewer holds an accepted");
    say("Communication grant on one of her houses:");
    say("================================================================");
    say(
      JSON.stringify(
        {
          storeQueryOwnerIds: inboxStoreOwnerIds(scope),
          grantedHousesOfAmbika: [...(scope.grantedHousesByOwner.get(AMBIKA) ?? [])],
          capitolHillRowIds: capitol.map((row) => row.id),
          brooklynRowIds: brooklyn.map((row) => row.id),
          ambikaRowListedAnywhere: [...capitol, ...brooklyn].some((row) => row.id === "msg_priya_other_owner"),
        },
        null,
        2,
      ),
    );
    say("");

    expect([...capitol, ...brooklyn].some((row) => row.id === "msg_priya_other_owner")).toBe(false);
  });
});
