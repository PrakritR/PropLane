// @vitest-environment jsdom
//
// Manager inbox message search. Three things this locks in, all of which broke
// when the search was first ported from a base where the inbox still owned its
// own page shell:
//
//  1. The search box must render when Communication owns the shell
//     (`embeddedInCommunication`). That is the ONLY way the real manager portal
//     mounts the inbox — `/portal/inbox/*` redirects to Communication — so a
//     search box rendered only in the standalone shell is reachable from /demo
//     and nowhere else.
//  2. Search spans folders, so the destructive trash-tab row actions must not
//     follow the active tab into search mode. Otherwise a per-row "Delete" on
//     the Trash tab permanently deletes a live inbox message, with no confirm.
//  3. Rows must be labelled from their own folder, not the active tab, or a
//     sent thread surfaced from Unopened is shown as if its recipient sent it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const THREADS = [
  {
    id: "thr-1000000001",
    folder: "inbox",
    from: "Dana Ramirez",
    email: "dana@example.com",
    subject: "Roof leak in unit 2",
    preview: "There is water coming through the ceiling",
    body: "There is water coming through the ceiling",
    time: "Jul 20, 2026",
    unread: true,
  },
  {
    id: "thr-1000000002",
    folder: "sent",
    from: "Property manager",
    email: "sam@example.com",
    subject: "Re: roof repair scheduled",
    preview: "The roofer comes Thursday",
    body: "The roofer comes Thursday",
    time: "Jul 19, 2026",
    unread: false,
  },
  {
    id: "thr-1000000003",
    folder: "trash",
    from: "Old Sender",
    email: "old@example.com",
    subject: "Roof flyer",
    preview: "discount roof inspection",
    body: "discount roof inspection",
    time: "Jul 01, 2026",
    unread: false,
  },
  {
    id: "thr-1000000004",
    folder: "inbox",
    from: "Jordan Fox",
    email: "jordan@example.com",
    subject: "Parking spot question",
    preview: "Can I get a second spot",
    body: "Can I get a second spot",
    time: "Jul 18, 2026",
    unread: false,
  },
];

const storageTest = vi.hoisted(() => ({
  realStorage: false,
  upsert: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
  pendingInboxSync: null as Promise<typeof THREADS> | null,
  persistInbox: vi.fn(),
}));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
  return ({
  ...actual,
  collapsePersonInboxThreads: (threads: unknown[]) => threads,
  resolveCollapsedInboxThread: (id: string | null, collapsed: Array<{ id: string }>) => collapsed.find((t) => t.id === id) ?? null,
  inboxThreadCounterpartyEmail: (t: { email?: string }) => t.email ?? "",
  mergeInboxRowsWithLocalTrash: (rows: unknown[]) => rows,
  countUnopenedPersistedInbox: () => 0,
  beginInboxMutation: () => {},
  endInboxMutation: () => {},
  appendPersistedInboxThread: () => {},
  seedDemoInbox: () => {},
  RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
  VENDOR_INBOX_STORAGE_KEY: "vendor-inbox",
  MANAGER_INBOX_STORAGE_KEY: "manager-inbox",
  PORTAL_INBOX_CHANGED_EVENT: actual.PORTAL_INBOX_CHANGED_EVENT,
  loadPersistedInbox: (...args: Parameters<typeof actual.loadPersistedInbox>) => storageTest.realStorage ? actual.loadPersistedInbox(...args) : THREADS,
  syncPersistedInboxFromServer: (...args: Parameters<typeof actual.syncPersistedInboxFromServer>) => storageTest.realStorage ? actual.syncPersistedInboxFromServer(...args) : storageTest.pendingInboxSync ?? Promise.resolve(THREADS),
  persistInbox: (...args: Parameters<typeof actual.persistInbox>) => storageTest.realStorage ? actual.persistInbox(...args) : storageTest.persistInbox(...args),
  persistInboxAwait: () => Promise.resolve(),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: (...args: Parameters<typeof actual.upsertPersistedInboxRows>) => storageTest.realStorage ? actual.upsertPersistedInboxRows(...args) : storageTest.upsert(...args),
  deleteInboxThreadIds: () => Promise.resolve(),
  inboxThreadSortMs: (id: string, t?: string) => {
    const m = String(id ?? "").match(/(\d{10,})/);
    if (m) return parseInt(m[1]!, 10);
    const p = Date.parse(t ?? "");
    return Number.isNaN(p) ? 0 : p;
  },
  inboxThreadManagerReplyPending: () => false,
  inboxThreadMessages: () => [],
  appendReplyToInboxThread: () => THREADS,
});
});

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => () => {},
}));

vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast }),
}));

vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [] }),
}));

vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({
  ManagerInboxSchedulePanel: () => null,
}));

vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: () => [],
  inboxCounterpartyName: (_email: string, fallback: string | null) => fallback,
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => !storageTest.realStorage,
}));

import { ManagerInbox } from "@/components/portal/pro-inbox";

afterEach(() => {
  cleanup();
  showToast.mockClear();
  storageTest.persistInbox.mockClear();
  storageTest.pendingInboxSync = null;
  storageTest.realStorage = false;
  storageTest.upsert.mockClear();
  vi.unstubAllGlobals();
});

function searchBox() {
  return screen.getByLabelText("Search messages by sender, subject, or content");
}

describe("manager inbox search", () => {
  it("persists only the opened thread through the real storage layer", async () => {
    storageTest.realStorage = true;
    const persisted = THREADS.map((row) => ({ ...row }));
    persisted[3]!.unread = true;
    const writes: Array<{ action: string; row?: { id: string; unread: boolean } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/portal-inbox-threads")) {
        if (!init?.method) return Response.json({ rows: persisted });
        const body = JSON.parse(String(init.body));
        writes.push(body);
        // An unrelated mailbox row rejects a full replacement. Opening A must
        // not depend on being able to rewrite every other conversation.
        if (body.action === "replace") return Response.json({ error: "Record not found" }, { status: 404 });
        if (body.action === "upsert") Object.assign(persisted.find((row) => row.id === body.row.id)!, body.row);
        return Response.json({ ok: true });
      }
      return Response.json({});
    }));

    const { rerender } = render(<ManagerInbox tabId="all" controlledExpandedId={null} suppressListPane />);
    rerender(<ManagerInbox tabId="all" controlledExpandedId="thr-1000000001" suppressListPane />);
    await waitFor(() => expect(persisted[0]!.unread).toBe(false));
    expect(persisted[3]!.unread).toBe(true);
    expect(writes).toEqual([expect.objectContaining({ action: "upsert", row: expect.objectContaining({ id: "thr-1000000001", unread: false }) })]);
    expect(screen.getByPlaceholderText("Write a reply…")).toBeTruthy();
  });

  it("persists read-on-open after inbox hydration", async () => {
    let finishSync!: (rows: typeof THREADS) => void;
    storageTest.pendingInboxSync = new Promise((resolve) => {
      finishSync = resolve;
    });

    render(<ManagerInbox tabId="unopened" controlledExpandedId="thr-1000000001" />);
    expect(storageTest.persistInbox).not.toHaveBeenCalled();

    finishSync(THREADS);
    await waitFor(() =>
      expect(storageTest.upsert).toHaveBeenCalledWith(
        "manager-inbox",
        [expect.objectContaining({ id: "thr-1000000001", unread: false })],
        expect.arrayContaining([expect.objectContaining({ id: "thr-1000000001", unread: false })]),
      ),
    );

    const readsBeforeUnread = storageTest.upsert.mock.calls.length;
    fireEvent(window, new Event("axis-portal-inbox-changed"));
    await waitFor(() =>
      expect(storageTest.persistInbox).toHaveBeenLastCalledWith(
        "manager-inbox",
        expect.arrayContaining([expect.objectContaining({ id: "thr-1000000001", unread: true })]),
      ),
    );
    expect(storageTest.upsert).toHaveBeenCalledTimes(readsBeforeUnread);
  });

  it("renders the search box when Communication owns the shell", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose commBase="/portal/communication" />);
    expect(searchBox()).toBeTruthy();
  });

  it("renders the search box in the standalone shell too", () => {
    render(<ManagerInbox tabId="unopened" />);
    expect(searchBox()).toBeTruthy();
  });

  it("matches across folders, excluding trash, ranked sender > subject > body", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    // Inbox + sent match; the trash thread whose subject also says "Roof" does not.
    expect(screen.getAllByText(/2 messages matching/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Roof flyer")).toBeNull();
  });

  it("labels each search row from its own folder, not the active tab", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    // The two-pane list has no column headers, but the folder-labelling
    // invariant still holds on the row itself: the sent thread is shown by
    // recipient, explicitly marked "To:", rather than looking like a message
    // Sam sent to the manager.
    expect(screen.getAllByText("To: sam@example.com").length).toBeGreaterThan(0);
  });

  /**
   * Actions live in the floating bulk bar now, which exists only while
   * something is SELECTED — the house convention every list follows. So these
   * two select a row rather than clicking it (a click opens the thread), and
   * then read the bar. The invariant being guarded is unchanged and is the
   * whole point of the first one: a live row surfaced by searching from the
   * Trash tab must never offer the trash-only Restore / Delete-forever.
   */
  const selectRowFor = (name: string | RegExp) => {
    const box = screen.getAllByRole("checkbox", {
      name: typeof name === "string" ? new RegExp(`Select conversation with .*${name}`, "i") : name,
    })[0]!;
    fireEvent.click(box);
  };

  it("never offers permanent delete on a search row opened from the Trash tab", () => {
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    // Positive control FIRST: the live row really is on screen, so the
    // absences below mean "not offered on this screen" rather than "the search
    // returned nothing and there was never anything to act on".
    expect(screen.getAllByText("Roof leak in unit 2").length).toBeGreaterThan(0);

    // The rows on screen are live inbox/sent messages, so the trash-only
    // Restore / Delete-forever actions must not be reachable. Search results
    // render without the selection checkbox, so there is no bulk bar here at
    // all — which satisfies the invariant, and is why this asserts absence
    // across the whole screen rather than selecting first.
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select conversation with/i })).toBeNull();
  });

  it("keeps the trash tab's own actions when no search is active", () => {
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);

    selectRowFor(/./);

    expect(screen.getAllByRole("button", { name: "Restore" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
  });

  it("says trash is excluded rather than letting a trashed message look gone", () => {
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });
    expect(screen.getAllByText(/Trash isn’t searched/).length).toBeGreaterThan(0);

    // Even with zero hits — the empty state alone would read as "no such message".
    fireEvent.change(searchBox(), { target: { value: "flyer" } });
    expect(screen.getAllByText(/No messages match/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Trash isn’t searched/).length).toBeGreaterThan(0);
  });

  it("names an escape hatch that works from the tab the reader is on", () => {
    // Re-clicking the already-active Trash pill leaves `tabId` unchanged, so
    // "open the Trash tab" would be a dead instruction exactly here.
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });
    expect(screen.getAllByText(/clear the search to browse it/).length).toBeGreaterThan(0);

    cleanup();
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });
    expect(screen.getAllByText(/clear the search, then open the Trash tab/).length).toBeGreaterThan(0);
  });

  it("says so instead of silently doing nothing when no selected row is unread", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    // The sent thread is already read, so bulk mark-read has nothing to do.
    fireEvent.click(screen.getAllByLabelText("Select message Re: roof repair scheduled")[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Nothing to mark read/));
    // The selection survives so the manager can correct it.
    expect(screen.getAllByRole("button", { name: "Mark read" }).length).toBeGreaterThan(0);
  });

  it("marks only the unread inbox rows of a mixed selection", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    fireEvent.click(screen.getAllByLabelText("Select message Re: roof repair scheduled")[0]!);
    fireEvent.click(screen.getAllByLabelText("Select message Roof leak in unit 2")[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Marked as read/));
    expect(showToast).not.toHaveBeenCalledWith(expect.stringMatching(/Nothing to mark read/));
  });

  it("ends the search when a tab is picked, so the pills are never inert", () => {
    const { rerender } = render(
      <ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />,
    );
    fireEvent.change(searchBox(), { target: { value: "roof" } });
    expect(screen.getAllByText(/messages matching/).length).toBeGreaterThan(0);

    rerender(<ManagerInbox tabId="sent" embeddedInCommunication externalTitleActions suppressCompose />);
    expect(screen.queryByText(/messages matching/)).toBeNull();
    expect(screen.getAllByText("Re: roof repair scheduled").length).toBeGreaterThan(0);
    expect(screen.queryByText("Roof leak in unit 2")).toBeNull();
  });

  it("clears back to the plain tab list", () => {
    render(<ManagerInbox tabId="unopened" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });
    expect(screen.getAllByText(/messages matching/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(screen.queryByText(/messages matching/)).toBeNull();
    // Back to Unopened: the unread inbox thread, and not the sent one.
    expect(screen.getAllByText("Roof leak in unit 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Re: roof repair scheduled")).toBeNull();
  });
});
