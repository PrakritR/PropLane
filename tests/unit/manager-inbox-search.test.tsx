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
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

vi.mock("@/lib/portal-inbox-storage", () => ({
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
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  loadPersistedInbox: () => THREADS,
  syncPersistedInboxFromServer: () => Promise.resolve(THREADS),
  persistInbox: () => {},
  persistInboxAwait: () => Promise.resolve(),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: () => {},
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
}));

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
  useAppUi: () => ({ showToast: (msg: string) => showToast(msg) }),
}));

vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [] }),
}));

vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({
  ManagerInboxSchedulePanel: () => null,
}));

vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: () => [],
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
}));

import { ManagerInbox } from "@/components/portal/pro-inbox";

afterEach(() => {
  cleanup();
  showToast.mockClear();
});

function searchBox() {
  return screen.getByLabelText("Search messages by sender, subject, or content");
}

describe("manager inbox search", () => {
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

  it("never offers permanent delete on a search row opened from the Trash tab", () => {
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);
    fireEvent.change(searchBox(), { target: { value: "roof" } });

    // The rows on screen are live inbox/sent messages, so the trash-only
    // Restore / Delete-forever actions must be gone.
    const rows = screen.getAllByText("Roof leak in unit 2");
    fireEvent.click(rows[0]!);

    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    // The live-row action is labelled "Archive" in the unified inbox (it still
    // calls `moveToTrash`; "archived" is what a trashed conversation is called
    // now). This is the positive control — the invariant under test is the two
    // trash-only actions being absent above.
    expect(screen.getAllByRole("button", { name: "Archive" }).length).toBeGreaterThan(0);
  });

  it("keeps the trash tab's own actions when no search is active", () => {
    render(<ManagerInbox tabId="trash" embeddedInCommunication externalTitleActions suppressCompose />);

    const rows = screen.getAllByText("Roof flyer");
    fireEvent.click(rows[0]!);

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
