// @vitest-environment jsdom
//
// Egress guard for the unified Communication inbox: with the SMS UI enabled the
// SMS poll must not run while the tab is backgrounded (we are on the Supabase
// free plan — a hidden page polling every 20s is pure waste), and it must
// refetch immediately when the manager comes back so the list is fresh on
// return. (When the SMS UI flag is OFF the poll never runs at all — covered by
// unified-conversation-inbox.test.tsx.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";

const scope = vi.hoisted(() => ({ viewer: "manager-test", workspace: "workspace-a", begin: null as null | (() => (mutation: {
  updated: Array<{ projectionId: string; archived: boolean; version: number }>;
  deleted: string[]; reconcile: string[];
}) => void) }));

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
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
  loadPersistedInbox: () => [],
  syncPersistedInboxFromServer: () => Promise.resolve([]),
  syncPersistedInboxFromServerWithStatus: () => Promise.resolve({ rows: [], ok: true }),
  persistInbox: () => {},
  persistInboxAwait: () => Promise.resolve(),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: () => Promise.resolve(true),
  deleteInboxThreadIds: () => Promise.resolve(true),
  appendReplyToInboxThread: () => null,
  inboxThreadSortMs: (id: string, t?: string) => {
    const m = String(id ?? "").match(/(\d{10,})/);
    if (m) return parseInt(m[1]!, 10);
    const p = Date.parse(t ?? "");
    return Number.isNaN(p) ? 0 : p;
  },
  inboxThreadMessages: () => [],
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ rows: [], ok: true }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: scope.viewer, email: "manager@example.com", ready: true }),
}));
vi.mock("@/hooks/use-selected-workspace-id", () => ({
  useActiveWorkspaceIdentity: () => ({ id: scope.workspace, isDefault: false }),
}));
vi.mock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => <div /> }));
vi.mock("@/components/portal/pro-sms-panel", () => ({ ManagerSmsPanel: (props: { onProjectionMutationStart?: typeof scope.begin }) => {
  scope.begin = props.onProjectionMutationStart ?? null;
  return <div />;
} }));

import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";

const SMS_URL = "/api/manager/sms-conversations";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility("visible");
  scope.viewer = "manager-test";
  scope.workspace = "workspace-a";
  scope.begin = null;
});

describe("unified Communication SMS poll", () => {
  it("skips the poll while the tab is hidden and refetches on refocus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ residents: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setVisibility("visible");

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    const smsCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes(SMS_URL)).length;
    await waitFor(() => expect(smsCalls()).toBe(1));

    // One visible tick -> one more fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(smsCalls()).toBe(2);

    // Backgrounded: three ticks, no fetches.
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(smsCalls()).toBe(2);

    // Back in the foreground: refetch immediately, no waiting for the next tick.
    await act(async () => {
      setVisibility("visible");
    });
    await waitFor(() => expect(smsCalls()).toBe(3));
  });

  it("drops a delayed SMS mutation after viewer and workspace A-B-A switches", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const resident = { projectionId: id, stateVersion: 1, archived: false, name: "Old page SMS",
      ownerManagerUserId: "manager-test", counterpartyRole: "prospect", phone: "+12065550100",
      messages: [{ id: "sms-1", direction: "inbound", body: "hello", createdAt: "2026-09-25T12:00:00Z" }] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ residents: [resident], nextCursor: null })));
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Old page SMS")).toBeTruthy());
    fireEvent.click(screen.getByText("Old page SMS"));
    await waitFor(() => expect(scope.begin).toBeTruthy());
    const staleViewerCommit = scope.begin?.();
    expect(staleViewerCommit).toBeTruthy();
    await act(async () => { scope.viewer = "manager-b"; view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />); });
    await act(async () => { scope.viewer = "manager-test"; view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />); });
    await waitFor(() => expect(screen.getByText("Old page SMS")).toBeTruthy());
    act(() => staleViewerCommit?.({ updated: [{ projectionId: id, archived: true, version: 2 }], deleted: [], reconcile: [] }));
    expect(screen.getByText("Old page SMS")).toBeTruthy();

    fireEvent.click(screen.getByText("Old page SMS"));
    await waitFor(() => expect(scope.begin).toBeTruthy());
    const staleWorkspaceCommit = scope.begin?.();
    await act(async () => { scope.workspace = "workspace-b"; view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />); });
    await act(async () => { scope.workspace = "workspace-a"; view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />); });
    await waitFor(() => expect(screen.getByText("Old page SMS")).toBeTruthy());
    act(() => staleWorkspaceCommit?.({ updated: [], deleted: [id], reconcile: [] }));
    expect(screen.getByText("Old page SMS")).toBeTruthy();
  });
});
