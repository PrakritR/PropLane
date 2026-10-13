// @vitest-environment jsdom
/**
 * Reviewer-visible evidence for workspace comms isolation (Oct 12 2026).
 *
 * Renders the REAL manager Communication list (`ManagerUnifiedInbox`) over the real contact
 * pipeline (`buildManagerInboxLiveContacts` → `buildResidentPlaceholderInboxItems`) and the real
 * `/api/portal-inbox-threads` route behind `fetch`, then writes each rendered state to
 * `$EVIDENCE_DIR` (default: the OS temp dir) as HTML a reviewer can open or screenshot:
 *
 *   01 — the same applications cache WITHOUT the workspace/ownership check (the pre-fix list:
 *        another owner's SEATTLE HOMES residents sitting in Prakrit's My workspace)
 *   02 — My workspace, after the check: only Prakrit's own resident
 *   03 — the SEATTLE HOMES workspace, same cache: only its own residents
 *   04 — the ⋯ menu on a "No messages yet" row: Archive AND the new Delete
 *   05 — after Delete: the row is gone
 *   06 — after a reload (dismissals read back from the server): still gone
 *   07 — a live conversation with the same person is never hidden by a dismissal
 *
 * The assertions are the evidence's own guard: a panel that does not say what its caption says
 * fails here rather than being written out as a misleading screenshot.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { WorkspacePayload } from "@/lib/workspaces/types";
import { RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";
import { createMemoryDb } from "./support/memory-supabase";

const OUT = process.env.EVIDENCE_DIR ?? join(tmpdir(), "proplane-comms-isolation-evidence");

const PRAKRIT = "owner-prakrit";
const AMBIKA = "owner-ambika";
const MY_WS = "ws-prakrit-default";
const SEATTLE_WS = "ws-ambika-default";
const MY_HOUSE = "house-brooklyn-5257";
const SEATTLE_HOUSE = "house-seattle-homes";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  invites: [] as unknown[],
  viewer: { id: "", email: "" },
  cookie: undefined as string | undefined,
  db: null as unknown,
}));

// ---- the client-side sources the contact directory is built from ----------------------------
vi.mock("@/lib/manager-applications-storage", () => ({
  readManagerApplicationRows: () => state.rows,
  syncManagerApplicationsFromServerWithStatus: async () => ({ ok: true }),
}));
vi.mock("@/lib/portal-data-store", () => ({ readCachedAccountLinkInvites: () => state.invites }));
vi.mock("@/lib/pro-relationships", () => ({ readProRelationships: () => [] }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  readOwnActiveManagerVendorRows: () => [],
  isVendorCategorySettingsRow: () => false,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: state.viewer.id, email: state.viewer.email, ready: true }),
}));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));

// ---- the server side of the dismissal: the real route over an in-memory database -------------
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined),
  }),
}));
vi.mock("@/lib/portal-inbox-thread-scope", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveInboxScopeUser: async () => ({
    user: { id: state.viewer.id, email: state.viewer.email, role: "manager" },
    db: state.db,
  }),
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

import { GET, POST } from "@/app/api/portal-inbox-threads/route";
import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { EMPTY_COMMUNICATION_THREAD_FILTERS } from "@/lib/communication-thread-filters";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";

// ---- fetch: the dismissal route is real; every other inbox read is empty --------------------
function installFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const absolute = url.startsWith("http") ? url : `https://example.test${url}`;
    if (absolute.includes("/api/portal-inbox-threads")) {
      const request = new Request(absolute, init as RequestInit);
      return (init?.method ?? "GET").toUpperCase() === "POST" ? POST(request) : GET(request);
    }
    return new Response(JSON.stringify({ residents: [], conversations: [], rows: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function resident(id: string, name: string, owner: string, house: string, houseLabel: string): DemoApplicantRow {
  return {
    id,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.test`,
    bucket: "approved",
    stage: "Active",
    detail: "",
    managerUserId: owner,
    propertyId: house,
    property: houseLabel,
  } as DemoApplicantRow;
}

function workspace(id: string, name: string, owner: string, owned: boolean, propertyIds: string[]) {
  return { id, name, ownerUserId: owner, owned, isDefault: owned, propertyIds, propertyPermissions: {} } as unknown as WorkspacePayload["workspaces"][number];
}

const PRAKRIT_RESIDENT = resident("app-1", "Dylan Reyes", PRAKRIT, MY_HOUSE, "5257 Brooklyn Ave NE");
const SEATTLE_RESIDENTS = [
  resident("app-2", "Khue Tran", AMBIKA, SEATTLE_HOUSE, "SEATTLE HOMES"),
  resident("app-3", "Shivansh Mehta", AMBIKA, SEATTLE_HOUSE, "SEATTLE HOMES"),
];

/** Exactly what the pre-fix `buildManagerInboxLiveContacts` produced: every cached row, unchecked. */
function contactsWithoutWorkspaceCheck() {
  return (state.rows as DemoApplicantRow[]).map((row) => ({
    id: `res-${row.id}`,
    name: row.name,
    email: row.email.toLowerCase(),
    role: "resident" as const,
    propertyLabel: row.property,
    propertyId: row.propertyId ?? undefined,
    tenancyStatus: "resident" as const,
  }));
}

function emptyAdapter(threads: PersistedInboxThread[]): CommunicationInboxAdapter {
  return {
    kind: "manager",
    storageKey: "evidence-inbox",
    threadsChangedEvent: "evidence-inbox-changed",
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

type PanelArgs = {
  contacts: ReturnType<typeof buildManagerInboxLiveContacts>;
  threads?: PersistedInboxThread[];
};

async function renderInbox({ contacts, threads = [] }: PanelArgs) {
  const view = render(
    <div style={{ width: "460px" }}>
      <ManagerUnifiedInbox
        tabId="communication"
        commBase="/portal/communication"
        listSegment="active"
        threadFilters={EMPTY_COMMUNICATION_THREAD_FILTERS}
        filterContacts={contacts}
        adapter={emptyAdapter(threads)}
      />
    </div>,
  );
  await waitFor(() => expect(document.querySelector("[data-communication-inbox-list]")).toBeTruthy());
  // The list settles after the dismissal read resolves.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  current = view.container;
  return view;
}

let current: HTMLElement | null = null;

function rowNames(): string[] {
  return [...(current ?? document.body).querySelectorAll(".portal-inbox-row")].map((row) =>
    (row.querySelector("p span")?.textContent ?? "").trim(),
  );
}

const panels: { id: string; caption: string; note: string; html: string }[] = [];

/**
 * The conversation list pane as rendered. `whole` also appends the portalled ⋯ menu, which React
 * mounts on document.body rather than inside the row.
 */
function capture(id: string, caption: string, note: string, opts: { whole?: boolean } = {}) {
  const pane = (current ?? document.body).querySelector("[data-communication-inbox-list]")?.parentElement;
  const popper = opts.whole ? document.body.querySelector("[data-radix-popper-content-wrapper]") : null;
  const html = `${(pane ?? current ?? document.body).innerHTML}${popper ? popper.outerHTML : ""}`;
  panels.push({ id, caption, note, html });
}

beforeEach(() => {
  // jsdom's default URL is "/", which `isDemoModeActive()` treats as the public demo surface
  // (the landing page embeds the demo frame). Render on the real portal path instead.
  window.history.replaceState({}, "", "/portal/communication");
  state.rows = [];
  state.invites = [];
  state.viewer = { id: PRAKRIT, email: "prakrit@example.test" };
  state.cookie = MY_WS;
  state.db = createMemoryDb({
    profiles: [
      { id: PRAKRIT, email: "prakrit@example.test", role: "manager" },
      { id: AMBIKA, email: "ambika@example.test", role: "manager" },
    ],
    portal_workspaces: [
      { id: MY_WS, name: "My workspace", owner_user_id: PRAKRIT, is_default: true, created_at: "2026-01-01" },
      { id: SEATTLE_WS, name: "SEATTLE HOMES", owner_user_id: AMBIKA, is_default: true, created_at: "2026-01-02" },
    ],
    manager_property_records: [
      { id: MY_HOUSE, manager_user_id: PRAKRIT, workspace_id: MY_WS, row_data: { buildingName: "5257 Brooklyn Ave NE" } },
      { id: SEATTLE_HOUSE, manager_user_id: AMBIKA, workspace_id: SEATTLE_WS, row_data: { buildingName: "SEATTLE HOMES" } },
    ],
    account_link_invites: [],
    communication_dismissed_contacts: [],
    portal_inbox_thread_records: [],
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
  writeFileSync(join(OUT, "comms-isolation-panels.json"), JSON.stringify(panels, null, 2));
});

describe("evidence: a workspace's Communication lists only its own people", () => {
  it("01 — the pre-fix list put another owner's SEATTLE HOMES residents in My workspace", async () => {
    setWorkspaceSelection({ workspaces: [workspace(MY_WS, "My workspace", PRAKRIT, true, [MY_HOUSE])], activeWorkspaceId: MY_WS });
    state.rows = [PRAKRIT_RESIDENT, ...SEATTLE_RESIDENTS];
    await renderInbox({ contacts: contactsWithoutWorkspaceCheck() });
    expect(rowNames()).toEqual(expect.arrayContaining(["Khue Tran", "Shivansh Mehta"]));
    capture("01-before-leak", "Before — My workspace, contacts built without the workspace check", "Ambika's SEATTLE HOMES residents are listed as 'No messages yet' rows in Prakrit's own Communication.");
  });

  it("02 — My workspace now lists only Prakrit's own resident", async () => {
    setWorkspaceSelection({ workspaces: [workspace(MY_WS, "My workspace", PRAKRIT, true, [MY_HOUSE])], activeWorkspaceId: MY_WS });
    state.rows = [PRAKRIT_RESIDENT, ...SEATTLE_RESIDENTS];
    await renderInbox({ contacts: buildManagerInboxLiveContacts(PRAKRIT) });
    expect(rowNames()).toEqual(["Dylan Reyes"]);
    capture("02-after-my-workspace", "After — My workspace (Prakrit)", "Same applications cache. Only the resident of the house this workspace holds; both SEATTLE HOMES rows are gone.");
  });

  it("03 — the SEATTLE HOMES workspace lists its own residents and none of Prakrit's", async () => {
    setWorkspaceSelection({ workspaces: [workspace(SEATTLE_WS, "SEATTLE HOMES", AMBIKA, false, [SEATTLE_HOUSE])], activeWorkspaceId: SEATTLE_WS });
    state.invites = [
      {
        id: "link-1",
        status: "accepted",
        direction: "incoming",
        assignedPropertyIds: [SEATTLE_HOUSE],
        propertyCoManagerPermissions: { [SEATTLE_HOUSE]: { inbox: { read: true } } },
      },
    ];
    state.rows = [PRAKRIT_RESIDENT, ...SEATTLE_RESIDENTS];
    await renderInbox({ contacts: buildManagerInboxLiveContacts("co-manager-viewer") });
    expect(rowNames().sort()).toEqual(["Khue Tran", "Shivansh Mehta"]);
    capture("03-after-seattle-workspace", "After — the SEATTLE HOMES workspace (accepted inbox grant)", "The same cache in the other workspace: its own two residents, and none of Prakrit's.");
  });
});

describe("evidence: deleting an empty chat is permanent", () => {
  async function openRowMenu(name: string) {
    const trigger = screen.getByRole("button", { name: `Actions for ${name}` });
    await act(async () => {
      fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0, ctrlKey: false });
      fireEvent.click(trigger);
    });
  }

  it("04-06 — the ⋯ menu offers Delete, the row leaves, and a reload does not bring it back", async () => {
    setWorkspaceSelection({ workspaces: [workspace(MY_WS, "My workspace", PRAKRIT, true, [MY_HOUSE])], activeWorkspaceId: MY_WS });
    state.rows = [PRAKRIT_RESIDENT];
    await renderInbox({ contacts: buildManagerInboxLiveContacts(PRAKRIT) });
    expect(rowNames()).toEqual(["Dylan Reyes"]);

    await openRowMenu("Dylan Reyes");
    const deleteButton = await screen.findByText("Delete");
    expect(screen.getByText("Archive")).toBeTruthy();
    capture("04-empty-chat-menu", "The ⋯ menu on a 'No messages yet' row", "Archive, and the Delete this change adds. Delete on an empty chat has nothing stored to remove, so it dismisses the person for this workspace.", { whole: true });

    // The menu ignores a destructive activation for RECORD_ACTION_DESTRUCTIVE_SETTLE_MS after it
    // opens (the iOS mis-tap guard) — a real person's click lands well after that.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 40));
    });
    await act(async () => {
      fireEvent.click(deleteButton);
    });
    await waitFor(() => expect(rowNames()).toEqual([]));
    capture("05-after-delete", "After Delete", "The empty chat is gone from Active.");

    // The dismissal reached the server, keyed on the signed-in viewer and the cookie's workspace.
    const stored = await (state.db as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: Record<string, unknown>[] }> } })
      .from("communication_dismissed_contacts")
      .select("*");
    expect(stored.data).toMatchObject([{ viewer_user_id: PRAKRIT, workspace_id: MY_WS, contact_key: "dylan@example.test" }]);

    // Reload: a brand-new mount reads the dismissals back and the row stays gone.
    cleanup();
    current = null;
    await renderInbox({ contacts: buildManagerInboxLiveContacts(PRAKRIT) });
    await waitFor(() => expect(rowNames()).toEqual([]));
    capture("06-after-reload", "After a reload", "A fresh page load reads the dismissal back from the server; the deleted empty chat does not return.");
  });

  it("07 — a dismissal never hides a live conversation with the same person", async () => {
    setWorkspaceSelection({ workspaces: [workspace(MY_WS, "My workspace", PRAKRIT, true, [MY_HOUSE])], activeWorkspaceId: MY_WS });
    state.rows = [PRAKRIT_RESIDENT];
    await (state.db as { from: (t: string) => { insert: (rows: unknown) => PromiseLike<unknown> } })
      .from("communication_dismissed_contacts")
      .insert([{ viewer_user_id: PRAKRIT, workspace_id: MY_WS, contact_key: "dylan@example.test" }]);
    const live: PersistedInboxThread = {
      id: "thread-live-1",
      folder: "inbox",
      from: "Dylan Reyes",
      email: "dylan@example.test",
      subject: "Leaky faucet",
      preview: "The kitchen tap is still dripping.",
      body: "The kitchen tap is still dripping.",
      time: "Oct 12, 9:14 AM",
      unread: true,
    };
    await renderInbox({ contacts: buildManagerInboxLiveContacts(PRAKRIT), threads: [live] });
    await waitFor(() => expect(rowNames()).toEqual(["Dylan Reyes"]));
    expect(document.body.textContent).toContain("The kitchen tap is still dripping.");
    capture("07-live-thread-kept", "A live conversation is never hidden", "The same person's empty chat is dismissed, yet their real conversation is listed with its message.");
  });
});
