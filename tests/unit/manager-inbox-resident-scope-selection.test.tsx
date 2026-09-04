// @vitest-environment jsdom
//
// Residents → detail → Communication mounts `ManagerInbox` with
// `filterResidentEmail` and NO list pane, so an effect — not a click — is what
// opens a conversation. Two things broke that and are locked in here:
//
//  1. The tab-change reset (`setExpandedId(null)`) is declared AFTER the
//     resident-scoped auto-select effect, so on a tab change it ran in the same
//     commit and won. Its deps never changed again, so the selection was never
//     restored: clicking "Archived (1)" opened nothing at all.
//  2. The archived view must select an ARCHIVED thread. The candidate filter
//     used to admit every thread when `tabId === "trash"`, which would surface a
//     live conversation under "Archived".
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const RESIDENT = "mason@example.com";

const THREADS = [
  {
    id: "thr-1000000001",
    folder: "inbox",
    from: "Mason Clark",
    email: RESIDENT,
    subject: "Live conversation",
    preview: "still open",
    body: "still open",
    time: "Jul 20, 2026",
    unread: true,
  },
  {
    id: "thr-1000000002",
    folder: "trash",
    from: "Mason Clark",
    email: RESIDENT,
    subject: "Archived conversation",
    preview: "put away",
    body: "put away",
    time: "Jul 18, 2026",
    unread: false,
  },
  {
    id: "thr-1000000003",
    folder: "inbox",
    from: "Someone Else",
    email: "other@example.com",
    subject: "Different resident",
    preview: "not this one",
    body: "not this one",
    time: "Jul 25, 2026",
    unread: true,
  },
];

vi.mock("@/lib/portal-inbox-storage", () => ({
  collapsePersonInboxThreads: (threads: unknown[]) => threads,
  resolveCollapsedInboxThread: (id: string | null, collapsed: Array<{ id: string }>) =>
    collapsed.find((t) => t.id === id) ?? null,
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

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
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

afterEach(cleanup);

function renderScoped(tabId: "unopened" | "trash") {
  return render(
    <ManagerInbox
      tabId={tabId}
      embeddedInCommunication
      externalTitleActions
      suppressCompose
      suppressListPane
      filterResidentEmail={RESIDENT}
      emptyThreadFallback={<div>NOTHING SELECTED</div>}
      commBase="/portal/communication"
    />,
  );
}

describe("resident-scoped inbox auto-selection", () => {
  it("opens the resident's live conversation on the default tab", () => {
    renderScoped("unopened");
    expect(screen.queryByText("NOTHING SELECTED")).toBeNull();
    // A live thread offers Archive, never the trash-only pair.
    expect(screen.getAllByRole("button", { name: "Archive" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("opens the ARCHIVED conversation on the archived tab", () => {
    renderScoped("trash");
    // The regression: the tab-change reset cleared this selection in the same
    // commit, so "Show archived" landed on the empty fallback.
    expect(screen.queryByText("NOTHING SELECTED")).toBeNull();
    // Restore + Delete prove the OPEN thread is the trashed one, not the live
    // one the old candidate filter would have admitted here.
    expect(screen.getAllByRole("button", { name: "Restore" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
});
