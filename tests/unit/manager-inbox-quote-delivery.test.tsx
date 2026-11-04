// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const THREADS: PersistedInboxThread[] = [{
  id: "vendor_quote_request_recipient", folder: "inbox", from: "Vendor",
  email: "vendor@example.com", subject: "Repair quote", preview: "Quote attached",
  body: "Quote attached", time: "Nov 3, 10:00 AM", unread: false,
}];

const storageTest = vi.hoisted(() => ({
  realStorage: false,
  upsert: vi.fn<(...args: unknown[]) => Promise<boolean>>(() => Promise.resolve(true)),
  pendingInboxSync: null as Promise<typeof THREADS> | null,
  threads: null as PersistedInboxThread[] | null,
  persistInbox: vi.fn(),
}));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-storage")>();
  return ({
  ...actual,
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
  loadPersistedInbox: (...args: Parameters<typeof actual.loadPersistedInbox>) => storageTest.realStorage ? actual.loadPersistedInbox(...args) : storageTest.threads ?? THREADS,
  syncPersistedInboxFromServer: (...args: Parameters<typeof actual.syncPersistedInboxFromServer>) => storageTest.realStorage ? actual.syncPersistedInboxFromServer(...args) : storageTest.pendingInboxSync ?? Promise.resolve(storageTest.threads ?? THREADS),
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
  inboxThreadMessages: actual.inboxThreadMessages,
  appendReplyToInboxThread: actual.appendReplyToInboxThread,
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
import { collapsePersonInboxThreads, normalizePersistedInboxThread } from "@/lib/portal-inbox-storage";

async function selectService(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Service", exact: true }));
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
}

afterEach(() => {
  cleanup();
  showToast.mockClear();
  storageTest.persistInbox.mockClear();
  storageTest.pendingInboxSync = null;
  storageTest.realStorage = false;
  storageTest.threads = null;
  storageTest.upsert.mockClear();
  vi.unstubAllGlobals();
});


describe("manager quote reply delivery", () => {
  it("accepts the server reply identity and delivery without a stale client upsert", async () => {
    let sentId = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      sentId = `quote-reply:${request.sendId}`;
      storageTest.pendingInboxSync = Promise.resolve([{
        ...THREADS[0]!, messages: [{ id: sentId, from: "Property manager", body: "Approved quote.", at: "Nov 3, 11:00 AM", outbound: true, channel: "email", delivery: "sent" }],
      }]);
      return Response.json({ ok: true, emailSent: true, messageId: sentId });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerInbox tabId="all" controlledExpandedId="vendor_quote_request_recipient" suppressListPane />);
    const composer = await screen.findByPlaceholderText("Write a reply…");
    await selectService("Repair quote");
    fireEvent.change(composer, { target: { value: "Approved quote." } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    expect(screen.getByText("Approved quote.", { selector: "p" })).toBeTruthy();
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.queryByText("Couldn't send")).toBeNull();
    expect(sentId).toMatch(/^quote-reply:[0-9a-f-]{36}$/);
    expect(storageTest.upsert).not.toHaveBeenCalled();
  });
  it("keeps a saved suppressed reply visibly failed and preserves the draft", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      ok: true, emailSent: false, deliveryState: "unsent",
      error: "This recipient withdrew from the quote request.",
      messageId: "quote-reply:suppressed",
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerInbox tabId="all" controlledExpandedId="vendor_quote_request_recipient" suppressListPane />);
    const composer = await screen.findByPlaceholderText("Write a reply…");
    await waitFor(() => expect(storageTest.persistInbox).toHaveBeenCalled());
    storageTest.persistInbox.mockClear();
    storageTest.upsert.mockClear();
    await selectService("Repair quote");
    fireEvent.change(composer, { target: { value: "Please confirm the quote." } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("This recipient withdrew from the quote request."));
    expect((composer as HTMLTextAreaElement).value).toBe("Please confirm the quote.");
    expect(screen.getByText("Couldn't send")).toBeTruthy();
    expect(screen.getByText("Please confirm the quote.", { selector: "p" })).toBeTruthy();
    const request = JSON.parse(String(fetchMock.mock.calls.find((call) => String(call[0]).includes("send-inbox-message"))?.[1]?.body));
    expect(request.quoteContextThreadId).toBe(THREADS[0]!.id);
    expect(request.sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect(storageTest.upsert).not.toHaveBeenCalled();
    expect(storageTest.persistInbox).not.toHaveBeenCalled();

    // A later server read retains the delivery result after leaving the pane.
    cleanup();
    storageTest.pendingInboxSync = Promise.resolve([{
      ...THREADS[0]!, messages: [{ id: "quote-reply:suppressed", from: "Property manager", body: "Please confirm the quote.", at: "Nov 3, 11:00 AM", outbound: true, channel: "email", delivery: "failed" }],
    }]);
    render(<ManagerInbox tabId="all" controlledExpandedId="vendor_quote_request_recipient" suppressListPane />);
    expect(await screen.findByText("Couldn't send")).toBeTruthy();
    expect(screen.getByText("Please confirm the quote.", { selector: "p" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["vendor_quote_request_recipient", "vendor_quote_second_recipient"])(
    "requires and sends the selected source %s when a newer generic row is canonical",
    async (sourceId) => {
      storageTest.threads = [
        { ...THREADS[0]!, recordRef: { kind: "service", id: "service-1", label: "Repair one" } },
        { ...THREADS[0]!, id: "vendor_quote_second_recipient", subject: "Second quote", time: "Nov 3, 10:30 AM", recordRef: { kind: "service", id: "service-2", label: "Repair two" } },
        { ...THREADS[0]!, id: "generic-thread", subject: "General", time: "Nov 3, 11:00 AM", body: "General message", recordRef: undefined },
      ];
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ ok: true, emailSent: true, messageId: "quote-reply:sent" }));
      vi.stubGlobal("fetch", fetchMock);
      render(<ManagerInbox tabId="all" controlledExpandedId="generic-thread" suppressListPane embeddedInCommunication />);
      const composer = await screen.findByPlaceholderText("Write a reply…");
      fireEvent.change(composer, { target: { value: "Reply" } });
      fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect((composer as HTMLTextAreaElement).value).toBe("Reply");
      await selectService(sourceId === THREADS[0]!.id ? "Repair one" : "Repair two");
      fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(request.threadId).toBe("generic-thread");
      expect(request.quoteContextThreadId).toBe(sourceId);
    },
  );

  it("requires selection when a single quote is folded into a newer generic row", async () => {
    storageTest.threads = [THREADS[0]!, { ...THREADS[0]!, id: "generic-thread", subject: "General", time: "Nov 3, 11:00 AM" }];
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ ok: true, emailSent: true, messageId: "quote-reply:sent" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerInbox tabId="all" controlledExpandedId="generic-thread" suppressListPane embeddedInCommunication />);
    const composer = await screen.findByPlaceholderText("Write a reply…");
    fireEvent.change(composer, { target: { value: "Reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    await selectService("Repair quote");
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.threadId).toBe("generic-thread");
    expect(request.quoteContextThreadId).toBe(THREADS[0]!.id);
  });

  it("retains quote choices and a failed reply when the server returns only a collapsed row", async () => {
    const raw = [
      { ...THREADS[0]!, recordRef: { kind: "service" as const, id: "service-1", label: "Repair one" } },
      { ...THREADS[0]!, id: "vendor_quote_second_recipient", subject: "Second quote", time: "Nov 3, 10:30 AM", recordRef: { kind: "service" as const, id: "service-2", label: "Repair two" } },
      { ...THREADS[0]!, id: "generic-thread", subject: "General", time: "Nov 3, 11:00 AM", body: "General message" },
    ];
    const serverRows = collapsePersonInboxThreads(raw, { mergeFolders: true }).map(normalizePersistedInboxThread);
    expect(serverRows).toHaveLength(1);
    expect(serverRows[0]!.quoteReplySources?.map((source) => source.threadId)).toEqual([
      THREADS[0]!.id, "vendor_quote_second_recipient",
    ]);
    expect(collapsePersonInboxThreads(serverRows, { mergeFolders: true })[0]!.quoteReplySources).toEqual(serverRows[0]!.quoteReplySources);
    storageTest.threads = serverRows;
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      ok: true, emailSent: false, deliveryState: "unsent", messageId: "quote-reply:failed", error: "Reply refused.",
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerInbox tabId="all" controlledExpandedId="generic-thread" suppressListPane embeddedInCommunication />);
    const composer = await screen.findByPlaceholderText("Write a reply…");
    fireEvent.change(composer, { target: { value: "Precollapsed reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    await selectService("Repair two");
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await waitFor(() => expect(screen.getByText("Couldn't send")).toBeTruthy());
    expect(screen.getByText("Precollapsed reply", { selector: "p" })).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("Precollapsed reply");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.threadId).toBe("generic-thread");
    expect(request.quoteContextThreadId).toBe("vendor_quote_second_recipient");
  });

});
