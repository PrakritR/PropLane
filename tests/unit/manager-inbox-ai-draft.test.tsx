// @vitest-environment jsdom
//
// Approval-first AI drafts must render in the UNIFIED Communication inbox, not
// only the legacy standalone inbox. The unified inbox mounts ManagerInbox with
// `embeddedInCommunication` + `suppressListPane` + a controlled `expandedId`
// (the row the parent list selected). This locks two things:
//
//  1. A thread the parent selected stays open — the on-mount `[tabId]` reset
//     must NOT clear a controlled selection (that regression left the right
//     pane stuck on "Select a conversation").
//  2. With the thread open, an incoming resident thread that carries a pending
//     `aiDraft` shows the PropLane AI approval card (Approve & Send / Edit /
//     Discard) — the same card as the legacy inbox.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";

const RESIDENT_MSG = {
  id: "thr-2000000001-root",
  from: "Dana Ramirez",
  body: "Hi, is there a parking spot available this month?",
  at: "Jul 20, 2026, 9:00 AM",
};

const THREADS = [
  {
    id: "thr-2000000001",
    folder: "inbox",
    from: "Dana Ramirez",
    email: "dana@example.com",
    subject: "Parking spot question",
    preview: RESIDENT_MSG.body,
    body: RESIDENT_MSG.body,
    time: "Jul 20, 2026",
    unread: true,
    aiDraft: { text: "Thanks for reaching out — I'll look into availability and follow up shortly.", status: "pending_approval" },
  },
];

let inboxRows = THREADS;

vi.mock("@/lib/portal-inbox-storage", () => ({
  collapsePersonInboxThreads: (threads: unknown[]) => threads,
  resolveCollapsedInboxThread: (id: string | null, collapsed: Array<{ id: string }>) => collapsed.find((t) => t.id === id) ?? null,
  inboxThreadCounterpartyEmail: (t: { email?: string }) => t.email ?? "",
  inboxThreadManagerReplyPending: () => true,
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
  loadPersistedInbox: () => inboxRows,
  syncPersistedInboxFromServer: () => Promise.resolve(inboxRows),
  persistInbox: (_key: string, rows: typeof THREADS) => {
    inboxRows = rows;
    window.dispatchEvent(new CustomEvent("portal-inbox-changed", { detail: { key: "manager-inbox" } }));
  },
  persistInboxAwait: () => Promise.resolve(),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: () => Promise.resolve(true),
  deleteInboxThreadIds: () => Promise.resolve(true),
  inboxThreadSortMs: (id: string, t?: string) => {
    const m = String(id ?? "").match(/(\d{10,})/);
    if (m) return parseInt(m[1]!, 10);
    const p = Date.parse(t ?? "");
    return Number.isNaN(p) ? 0 : p;
  },
  inboxThreadMessages: () => [RESIDENT_MSG],
  appendReplyToInboxThread: () => THREADS[0],
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/portal/payment-schedule-ui", () => ({ useScheduledPaymentMessages: () => ({ messages: [] }) }));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({ ManagerInboxSchedulePanel: () => null }));
vi.mock("@/lib/manager-inbox-contacts", () => ({ buildManagerInboxLiveContacts: () => [] }));
// AI drafts are deliberately gated OFF in demo mode; this is the real portal.
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { ManagerInbox } from "@/components/portal/pro-inbox";

afterEach(() => cleanup());

function InboxChangeObserver() {
  const [changeCount, setChangeCount] = useState(0);
  useEffect(() => {
    const onChange = () => setChangeCount((count) => count + 1);
    window.addEventListener("portal-inbox-changed", onChange);
    return () => window.removeEventListener("portal-inbox-changed", onChange);
  }, []);
  return <output data-testid="inbox-change-count">{changeCount}</output>;
}

describe("AI draft in the unified Communication inbox", () => {
  afterEach(() => {
    inboxRows = THREADS;
    vi.unstubAllGlobals();
  });

  it("keeps a controlled selection open and shows the approval card on an incoming resident thread", async () => {
    // No draft-reply fetch is needed — the thread already carries a pending
    // aiDraft — but stub fetch so any background call is inert.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    let controlledId: string | null = "thr-2000000001";
    render(
      <ManagerInbox
        tabId="unopened"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        commBase="/portal/communication"
        controlledExpandedId={controlledId}
        onControlledExpandedIdChange={(id) => {
          controlledId = id;
        }}
      />,
    );

    // The controlled selection was NOT wiped on mount…
    expect(controlledId).toBe("thr-2000000001");
    // …and the approval card + its actions render for the resident thread.
    expect(await screen.findByText("Approve & Send")).toBeTruthy();
    expect(screen.getByText(/I'll look into availability/)).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("Discard")).toBeTruthy();
  });

  it("persists an auto-draft after commit, not from a state updater", async () => {
    inboxRows = [{ ...THREADS[0], aiDraft: undefined }];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            draft: { text: "I’ll check the parking availability and follow up.", status: "pending_approval" },
          }),
          { status: 200 },
        ),
      ),
    );

    render(
      <>
        <InboxChangeObserver />
        <ManagerInbox
          tabId="unopened"
          embeddedInCommunication
          externalTitleActions
          suppressCompose
          suppressListPane
          commBase="/portal/communication"
          controlledExpandedId="thr-2000000001"
        />
      </>,
    );

    await screen.findByText(/I’ll check the parking availability/);
    await waitFor(() => expect(screen.getByTestId("inbox-change-count").textContent).not.toBe("0"));
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Cannot update a component");
    consoleError.mockRestore();
  });
});
