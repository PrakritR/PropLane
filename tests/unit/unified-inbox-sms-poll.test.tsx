// @vitest-environment jsdom
//
// Egress guard for the unified Communication inbox: with the SMS UI enabled the
// SMS poll must not run while the tab is backgrounded (we are on the Supabase
// free plan — a hidden page polling every 20s is pure waste), and it must
// refetch immediately when the manager comes back so the list is fresh on
// return. (When the SMS UI flag is OFF the poll never runs at all — covered by
// unified-conversation-inbox.test.tsx.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup, waitFor } from "@testing-library/react";

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
vi.mock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => <div /> }));
vi.mock("@/components/portal/pro-sms-panel", () => ({ ManagerSmsPanel: () => <div /> }));

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
});
