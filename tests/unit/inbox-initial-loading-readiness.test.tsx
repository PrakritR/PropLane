// @vitest-environment jsdom
//
// PRP-470 behavioral coverage. These tests deliberately hold the real client
// responses with deferred promises: a cache/staged row is not evidence that
// the initial Communication list is complete.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function thread(id: string, from: string) {
  return {
    id,
    folder: "inbox" as const,
    from,
    email: `${id}@example.com`,
    subject: "A deferred conversation",
    preview: "A deferred conversation",
    body: "A deferred conversation",
    time: "Sep 13, 2026",
    unread: false,
  };
}

describe("PRP-470 inbox request identity", () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not let an old viewer response populate the next viewer's cache", async () => {
    const storage = await import("@/lib/portal-inbox-storage");
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("viewer-a");
    session.markPortalSessionActive();

    const oldResponse = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(oldResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    const old = storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });
    session.setPortalSessionViewer("viewer-b");
    fetchMock.mockResolvedValueOnce(Response.json({ rows: [thread("b-thread", "Viewer B")] }));

    await expect(
      storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true }),
    ).resolves.toEqual({ rows: [expect.objectContaining({ id: "b-thread" })], ok: true });

    oldResponse.resolve(Response.json({ rows: [thread("a-thread", "Viewer A")] }));
    await expect(old).resolves.toEqual({ rows: [], ok: false, stale: true });
    expect(storage.loadPersistedInbox("axis_portal_inbox_manager_v1", [])).toEqual([
      expect.objectContaining({ id: "b-thread" }),
    ]);
  });

  it("ignores a late old-account 401 without ending the new session", async () => {
    const storage = await import("@/lib/portal-inbox-storage");
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("viewer-a");
    session.markPortalSessionActive();

    const oldResponse = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(oldResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const old = storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });

    session.setPortalSessionViewer("viewer-b");
    fetchMock.mockResolvedValueOnce(Response.json({ rows: [] }));
    await storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });

    oldResponse.resolve(new Response(null, { status: 401 }));
    await expect(old).resolves.toEqual({ rows: [], ok: false, stale: true });
    expect(session.portalSessionEnded()).toBe(false);
  });

  it("keeps an A to B to A request slot owned by the newest A request", async () => {
    const storage = await import("@/lib/portal-inbox-storage");
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("viewer-a");
    session.markPortalSessionActive();

    const oldA = deferred<Response>();
    const newA = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce(Response.json({ rows: [thread("b-thread", "Viewer B")] }))
      .mockReturnValueOnce(newA.promise);
    vi.stubGlobal("fetch", fetchMock);

    const firstA = storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });
    session.setPortalSessionViewer("viewer-b");
    await storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });
    session.setPortalSessionViewer("viewer-a");
    const secondA = storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true });

    oldA.resolve(Response.json({ rows: [thread("old-a-thread", "Old A")] }));
    await expect(firstA).resolves.toEqual({ rows: [], ok: false, stale: true });

    // The old A finally block must not delete the current A promise. This
    // non-forced call should join the existing request instead of starting a
    // fourth fetch.
    const joinedA = storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    newA.resolve(Response.json({ rows: [thread("new-a-thread", "New A")] }));
    await expect(secondA).resolves.toEqual({ rows: [expect.objectContaining({ id: "new-a-thread" })], ok: true });
    await expect(joinedA).resolves.toEqual({ rows: [expect.objectContaining({ id: "new-a-thread" })], ok: true });
    expect(storage.loadPersistedInbox("axis_portal_inbox_manager_v1", [])).toEqual([
      expect.objectContaining({ id: "new-a-thread" }),
    ]);
  });

  it("does not classify a successful HTTP response with malformed rows as an empty success", async () => {
    const storage = await import("@/lib/portal-inbox-storage");
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("viewer-malformed");
    session.markPortalSessionActive();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ rows: { unexpected: true } })));

    await expect(
      storage.syncPersistedInboxFromServerWithStatus("axis_portal_inbox_manager_v1", { force: true }),
    ).resolves.toEqual({ rows: [], ok: false });
  });
});

describe("PRP-470 initial Communication readiness", () => {
  let activeViewerId: string;
  let inboxResult: Promise<ReturnType<typeof thread>[]>;
  let resolveInbox!: (rows: ReturnType<typeof thread>[]) => void;
  let smsResult: Deferred<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    activeViewerId = "viewer-ui";
    const inbox = deferred<ReturnType<typeof thread>[]>();
    inboxResult = inbox.promise;
    resolveInbox = inbox.resolve;
    smsResult = deferred<Response>();
    fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/manager/sms-conversations") || url.includes("/api/resident/sms-conversations")) {
        return smsResult.promise;
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
    vi.doMock("@/hooks/use-portal-session", () => ({
      usePortalSession: () => ({ userId: activeViewerId, email: "viewer@example.com", ready: true }),
    }));
    vi.doMock("@/components/providers/app-ui-provider", () => ({
      useOptionalAppUi: () => null,
      useConfirm: () => async () => true,
    }));
    vi.doMock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
    vi.doMock("@/components/portal/pro-inbox", () => ({
      ManagerInbox: () => <div data-testid="embedded-email-thread" />,
    }));
    vi.doMock("@/components/portal/pro-sms-panel", () => ({
      ManagerSmsPanel: () => <div data-testid="embedded-sms-thread" />,
      smsOutboundPreviewPrefix: () => "",
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the manager list loading until the deferred inbox succeeds", async () => {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServer: () => inboxResult,
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" onAddConversation={() => {}} />);

    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading conversations…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add conversation/i })).toBeNull();
    expect(screen.queryByText(/No (messages|conversations)/i)).toBeNull();
    expect(screen.queryByText("Deferred manager")).toBeNull();

    await act(async () => resolveInbox([thread("manager-thread", "Deferred manager")]));
    await waitFor(() => expect(screen.getByText("Deferred manager")).toBeTruthy());
    expect(screen.queryByText("Loading conversations…")).toBeNull();
  });

  it("waits for enabled manager SMS before revealing the complete initial list", async () => {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServer: () => inboxResult,
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await act(async () => resolveInbox([thread("manager-thread", "Email resident")]));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/manager/sms-conversations"))).toBe(true));
    expect(screen.queryByText("Email resident")).toBeNull();
    expect(screen.getByText("Loading conversations…")).toBeTruthy();

    await act(async () => smsResult.resolve(Response.json({ residents: [] })));
    await waitFor(() => expect(screen.getByText("Email resident")).toBeTruthy());
  });

  it("does not publish a late SMS response across an A to B to A viewer cycle", async () => {
    const oldA = deferred<Response>();
    const viewerB = deferred<Response>();
    const newA = deferred<Response>();
    let returnedToA = false;
    fetchMock.mockImplementation(() => {
      if (activeViewerId === "viewer-next") return viewerB.promise;
      return returnedToA ? newA.promise : oldA.promise;
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const oldViewerCallCount = fetchMock.mock.calls.length;
    activeViewerId = "viewer-next";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(oldViewerCallCount));
    const nextViewerCallCount = fetchMock.mock.calls.length;
    returnedToA = true;
    activeViewerId = "viewer-ui";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(nextViewerCallCount));

    await act(async () => newA.resolve(Response.json({ residents: [] })));
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());
    await act(async () => oldA.resolve(Response.json({
      residents: [{
        residentUserId: null,
        residentEmail: null,
        name: "Prior viewer contact",
        savedContactName: "Prior viewer contact",
        phone: "+12025550199",
        propertyLabel: null,
        counterpartyRole: "unknown",
        conversationKey: "viewer-old:unknown:+12025550199",
        messages: [],
      }],
    })));
    await act(async () => viewerB.resolve(Response.json({ residents: [] })));

    expect(screen.queryByText("Prior viewer contact")).toBeNull();
  });

  it.each([
    ["inbox first", "inbox-first"],
    ["applications first", "applications-first"],
  ] as const)("waits for inbox and applications in either completion order (%s)", async (_label, order) => {
    const applications = deferred<DemoApplicantRow[]>();
    let applicationRows: DemoApplicantRow[] = [];
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => {
        const rows = await applications.promise;
        applicationRows = rows;
        return { rows, ok: true };
      },
      readManagerApplicationRows: () => applicationRows,
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const contact: InboxScopedContact = {
      id: "app-deferred",
      name: "Deferred applicant",
      email: "deferred-applicant@example.com",
      role: "resident",
      tenancyStatus: "applicant",
    };
    function Harness() {
      const [contacts, setContacts] = useState<InboxScopedContact[]>([]);
      const onApplicationsLoaded = useCallback(() => setContacts([contact]), []);
      return (
        <ManagerUnifiedInbox
          tabId="unopened"
          commBase="/portal/communication"
          filterContacts={contacts}
          onApplicationsLoaded={onApplicationsLoaded}
        />
      );
    }
    render(<Harness />);

    if (order === "inbox-first") {
      await act(async () => resolveInbox([]));
      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByText("Deferred applicant")).toBeNull();
      await act(async () => applications.resolve([{ id: "application-1" } as DemoApplicantRow]));
    } else {
      await act(async () => applications.resolve([{ id: "application-1" } as DemoApplicantRow]));
      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByText("Deferred applicant")).toBeNull();
      await act(async () => resolveInbox([]));
    }

    await waitFor(() => expect(screen.getByText("Deferred applicant")).toBeTruthy());
  });

  it("treats malformed enabled manager SMS payloads as an initial load error", async () => {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await act(async () => resolveInbox([thread("manager-thread", "Email resident")]));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/manager/sms-conversations"))).toBe(true));
    await act(async () => smsResult.resolve(Response.json({ residents: { malformed: true } })));

    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(screen.queryByText("Email resident")).toBeNull();
  });

  it("does not fetch disabled SMS and reveals a successful empty inbox state", async () => {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServer: () => inboxResult,
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        listSegment="archived"
        smsUiEnabled={false}
      />,
    );

    await act(async () => resolveInbox([]));
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/manager/sms-conversations"))).toBe(false);
    const archived = screen.getByRole("link", { name: /^Archived/ });
    expect(archived).toHaveAttribute("href", "/portal/communication/archived");
    expect(archived).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Active conversations" })).toHaveAttribute(
      "href",
      "/portal/communication/active",
    );
  });

  it("shows a retryable load error and recovers on retry", async () => {
    let calls = 0;
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServer: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("network down")) : Promise.resolve([thread("recovered", "Recovered resident")]);
      },
      syncPersistedInboxFromServerWithStatus: async () => {
        calls += 1;
        return calls === 1
          ? { rows: [], ok: false }
          : { rows: [thread("recovered", "Recovered resident")], ok: true };
      },
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" onAddConversation={() => {}} />);

    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /add conversation/i })).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: /retry/i }).click();
    });
    await waitFor(() => expect(screen.getByText("Recovered resident")).toBeTruthy());
    expect(screen.queryByText("Could not load conversations.")).toBeNull();
  });

  it("keeps the resident list loading until its deferred inbox succeeds", async () => {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: await inboxResult, ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("next/navigation", () => ({
      usePathname: () => "/resident/communication/active",
      useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams(),
    }));
    vi.doMock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
    vi.doMock("@/components/portal/resident-inbox-panel", () => ({
      ResidentInboxPanel: () => <div data-testid="resident-thread" />,
    }));
    vi.doMock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div data-testid="resident-sms" /> }));
    vi.doMock("@/components/portal/resident-manager-number-card", () => ({ ResidentManagerNumberCard: () => <div /> }));
    const { ResidentCommunication } = await import("@/components/portal/resident-communication");
    render(<ResidentCommunication smsUiEnabled={false} />);

    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Deferred resident")).toBeNull();

    await act(async () => resolveInbox([thread("resident-thread", "Deferred resident")]));
    await waitFor(() => expect(screen.getByText("Deferred resident")).toBeTruthy());
    expect(screen.queryByText("Loading conversations…")).toBeNull();
  });

  it.each([401, 403])("lets viewer B retry after a retryable SMS failure and a late A %s response", async (lateStatus) => {
    const viewerA = deferred<Response>();
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      if (smsCalls === 1) return viewerA.promise;
      if (smsCalls === 2) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(Response.json({ residents: [{
        residentUserId: null,
        residentEmail: "b@example.com",
        name: "Viewer B contact",
        savedContactName: null,
        phone: "+12025550102",
        propertyLabel: null,
        conversationKey: "viewer-b:unknown:+12025550102",
        messages: [],
      }] }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBe(1));

    activeViewerId = "viewer-next";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBe(2));
    await act(async () => viewerA.resolve(new Response(null, { status: lateStatus })));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());

    await act(async () => screen.getByRole("button", { name: /retry/i }).click());
    await waitFor(() => expect(smsCalls).toBe(3));
    await waitFor(() => expect(screen.getByText("Viewer B contact")).toBeTruthy());
    expect(screen.queryByText("Could not load conversations.")).toBeNull();
  });

  it.each([401, 403])("retries a same-viewer initial SMS %s refusal only when requested", async (status) => {
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      return smsCalls === 1
        ? Promise.resolve(new Response(null, { status }))
        : Promise.resolve(Response.json({ residents: [{
          residentUserId: null, residentEmail: "recovered@example.com", name: "Recovered same viewer",
          savedContactName: null, phone: "+12025550112", propertyLabel: null,
          conversationKey: "viewer-ui:unknown:+12025550112", messages: [],
        }] }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [], syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }), readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(screen.queryByText("Recovered same viewer")).toBeNull();
    expect(smsCalls).toBe(1);

    await act(async () => screen.getByRole("button", { name: /retry/i }).click());
    await waitFor(() => expect(smsCalls).toBe(2));
    await waitFor(() => expect(screen.getByText("Recovered same viewer")).toBeTruthy());
    expect(screen.queryByText("Could not load conversations.")).toBeNull();
  });

  it("keeps a same-viewer auth refusal paused through automatic refreshes until a later explicit retry", async () => {
    const statuses = [401, 403, 200];
    let smsCalls = 0;
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      const status = statuses[smsCalls++]!;
      return status === 200
        ? Promise.resolve(Response.json({ residents: [{
          residentUserId: null, residentEmail: "later@example.com", name: "Later explicit retry",
          savedContactName: null, phone: "+12025550113", propertyLabel: null,
          conversationKey: "viewer-ui:unknown:+12025550113", messages: [],
        }] }))
        : Promise.resolve(new Response(null, { status }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [], syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }), readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    // Initial failures never install the 20-second background timer, and
    // refocusing the tab cannot bypass the current-viewer auth pause.
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20_000)).toHaveLength(0);
    expect(smsCalls).toBe(1);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(smsCalls).toBe(1);

    await act(async () => screen.getByRole("button", { name: /retry/i }).click());
    await waitFor(() => expect(smsCalls).toBe(2));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 20_000)).toHaveLength(0);
    expect(smsCalls).toBe(2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(smsCalls).toBe(2);

    await act(async () => screen.getByRole("button", { name: /retry/i }).click());
    await waitFor(() => expect(smsCalls).toBe(3));
    await waitFor(() => expect(screen.getByText("Later explicit retry")).toBeTruthy());
  });

  it("resets a legitimate A SMS auth halt when B signs in", async () => {
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      return smsCalls === 1
        ? Promise.resolve(new Response(null, { status: 401 }))
        : Promise.resolve(Response.json({ residents: [{
          residentUserId: null, residentEmail: "b@example.com", name: "B after login",
          savedContactName: null, phone: "+12025550103", propertyLabel: null,
          conversationKey: "viewer-b:unknown:+12025550103", messages: [],
        }] }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());

    activeViewerId = "viewer-next";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBe(2));
    await waitFor(() => expect(screen.getByText("B after login")).toBeTruthy());
  });

  it("keeps same-viewer optimistic empty contacts, but clears them across A-B-A generations", async () => {
    const aContact = {
      residentUserId: null, residentEmail: null, name: "Saved A contact", savedContactName: "Saved A contact",
      phone: "+12025550104", propertyLabel: null, conversationKey: "a:unknown:+12025550104", messages: [],
    };
    const optimistic = {
      residentUserId: null, residentEmail: null, name: "Optimistic A contact", savedContactName: "Optimistic A contact",
      phone: "+12025550105", propertyLabel: null, conversationKey: "a:unknown:+12025550105", messages: [],
    };
    const aAgain = deferred<Response>();
    let smsCalls = 0;
    let returnedToA = false;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      if (smsCalls === 1) return Promise.resolve(Response.json({ residents: [aContact] }));
      if (!returnedToA) return Promise.resolve(Response.json({ residents: [] }));
      return aAgain.promise;
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [], syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }), readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Saved A contact")).toBeTruthy());

    window.dispatchEvent(new CustomEvent("axis:manager-sms-contacts-changed", { detail: { optimisticResident: optimistic } }));
    await waitFor(() => expect(screen.getByText("Optimistic A contact")).toBeTruthy());

    activeViewerId = "viewer-next";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText("Saved A contact")).toBeNull();
    expect(screen.queryByText("Optimistic A contact")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());

    returnedToA = true;
    activeViewerId = "viewer-ui";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText("Saved A contact")).toBeNull();
    await act(async () => aAgain.resolve(Response.json({ residents: [aContact] })));
    await waitFor(() => expect(screen.getByText("Saved A contact")).toBeTruthy());
  });

  it("gates resident Communication on enabled SMS and recovers through Retry", async () => {
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/resident/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      return smsCalls === 1
        ? Promise.resolve(new Response(null, { status: 503 }))
        : Promise.resolve(Response.json({ messages: [{
          id: "resident-sms-1", direction: "inbound", body: "Resident recovered SMS", fromPhone: "+12025550106",
          toPhone: "+12025550107", messageSid: null, source: "work_number", createdAt: "2026-09-13T12:00:00.000Z",
        }] }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [], syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }), stagePersistedInboxRows: () => {},
    }));
    vi.doMock("next/navigation", () => ({ usePathname: () => "/resident/communication/active", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
    vi.doMock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
    vi.doMock("@/components/portal/resident-inbox-panel", () => ({ ResidentInboxPanel: () => <div /> }));
    vi.doMock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div /> }));
    vi.doMock("@/components/portal/resident-manager-number-card", () => ({ ResidentManagerNumberCard: () => <div /> }));
    const { ResidentCommunication } = await import("@/components/portal/resident-communication");
    render(<ResidentCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    await act(async () => screen.getByRole("button", { name: /retry/i }).click());
    await waitFor(() => expect(screen.getByText("Resident recovered SMS")).toBeTruthy());
    expect(smsCalls).toBe(2);
  });

  it("does not publish a deferred resident SMS response from the previous viewer", async () => {
    const oldViewer = deferred<Response>();
    const newViewer = deferred<Response>();
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/resident/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      return smsCalls === 1 ? oldViewer.promise : newViewer.promise;
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: async () => ({ rows: [], ok: true }),
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("next/navigation", () => ({ usePathname: () => "/resident/communication/active", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
    vi.doMock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
    vi.doMock("@/components/portal/resident-inbox-panel", () => ({ ResidentInboxPanel: () => <div /> }));
    vi.doMock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div /> }));
    vi.doMock("@/components/portal/resident-manager-number-card", () => ({ ResidentManagerNumberCard: () => <div /> }));
    const { ResidentCommunication } = await import("@/components/portal/resident-communication");
    const view = render(<ResidentCommunication smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBe(1));
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Current resident SMS")).toBeNull();
    activeViewerId = "viewer-next";
    view.rerender(<ResidentCommunication smsUiEnabled />);
    await waitFor(() => expect(smsCalls).toBe(2));
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Current resident SMS")).toBeNull();
    await act(async () => newViewer.resolve(Response.json({ messages: [{
      id: "new-resident-sms", direction: "inbound", body: "Current resident SMS", fromPhone: "+12025550109",
      toPhone: "+12025550110", messageSid: null, source: "work_number", createdAt: "2026-09-13T12:00:00.000Z",
    }] })));
    await waitFor(() => expect(screen.getByText("Current resident SMS")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => oldViewer.resolve(Response.json({ messages: [{
      id: "old-resident-sms", direction: "inbound", body: "Stale resident SMS", fromPhone: "+12025550111",
      toPhone: "+12025550112", messageSid: null, source: "work_number", createdAt: "2026-09-13T11:00:00.000Z",
    }] })));
    expect(screen.queryByText("Stale resident SMS")).toBeNull();
    expect(screen.getByText("Current resident SMS")).toBeTruthy();
  });

  it("keeps a ready manager list and selection when background SMS refresh fails", async () => {
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes("/api/manager/sms-conversations")) return Promise.resolve(Response.json({}));
      smsCalls += 1;
      return Promise.resolve(smsCalls === 1
        ? Response.json({ residents: [{ residentUserId: null, residentEmail: "ready@example.com", name: "Ready SMS", savedContactName: null, phone: "+12025550108", propertyLabel: null, conversationKey: "ready:unknown:+12025550108", messages: [] }] })
        : new Response(null, { status: 503 }));
    });
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [], syncPersistedInboxFromServerWithStatus: async () => ({ rows: [thread("ready-email", "Ready email")], ok: true }), stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: async () => ({ rows: [], ok: true }), readManagerApplicationRows: () => [],
    }));
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Ready SMS")).toBeTruthy());
    await act(async () => screen.getByText("Ready SMS").closest("button")?.click());
    await waitFor(() => expect(screen.getByText("Ready SMS").closest(".portal-inbox-row")?.className).toContain("portal-inbox-row--selected"));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(smsCalls).toBe(2));
    expect(screen.getByText("Ready SMS")).toBeTruthy();
    expect(screen.getByText("Ready SMS").closest(".portal-inbox-row")?.className).toContain("portal-inbox-row--selected");
  });
});

describe("PRP-470 direct-send refresh publication", () => {
  let activeViewerId: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let firstDirectOnSent: (() => void) | undefined;
  let latestDirectOnSent: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    activeViewerId = "viewer-a";
    firstDirectOnSent = undefined;
    latestDirectOnSent = undefined;
    fetchMock = vi.fn((url: string) => Promise.resolve(Response.json(
      url.includes("/api/manager/sms-conversations") ? { residents: [] } : {},
    )));
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
    vi.doMock("@/hooks/use-portal-session", () => ({
      usePortalSession: () => ({ userId: activeViewerId, email: `${activeViewerId}@example.com`, ready: true }),
    }));
    vi.doMock("@/components/providers/app-ui-provider", () => ({
      useOptionalAppUi: () => null,
      useConfirm: () => async () => true,
    }));
    vi.doMock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
    vi.doMock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => <div /> }));
    vi.doMock("@/components/portal/pro-sms-panel", () => ({
      ManagerSmsPanel: () => <div />,
      smsOutboundPreviewPrefix: () => "",
    }));
    vi.doMock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => <div /> }));
    vi.doMock("@/components/portal/portal-contact-details-modal", () => ({ PortalContactDetailsModal: () => null }));
    vi.doMock("@/components/portal/communication-list-bulk-bar", () => ({ CommunicationListBulkBar: () => null }));
    vi.doMock("@/lib/portal-communication-nav", () => ({
      clearCommunicationThreadUrl: vi.fn(),
      selectCommunicationThreadUrl: vi.fn(),
    }));
    vi.doMock("@/components/portal/pro-resident-detail-inbox", () => ({
      ResidentDirectChatPane: ({ onSent }: { onSent: () => void }) => {
        firstDirectOnSent ??= onSent;
        latestDirectOnSent = onSent;
        return <button type="button" data-testid="direct-send-complete" onClick={onSent}>Send complete</button>;
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function setupStorage(
    statusLoader: (options?: { force?: boolean }) => Promise<unknown>,
  ) {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      syncPersistedInboxFromServerWithStatus: (_key: string, options?: { force?: boolean }) => statusLoader(options),
      syncPersistedInboxFromServer: (_key: string, options?: { force?: boolean }) => statusLoader(options) as Promise<ReturnType<typeof thread>[]>,
      stagePersistedInboxRows: () => {},
    }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ rows: [], ok: true }),
      readManagerApplicationRows: () => [],
    }));
  }

  const contact = (viewer: string): InboxScopedContact => ({
    id: `${viewer}-contact`,
    name: `${viewer} contact`,
    email: `${viewer}@example.com`,
    role: "resident",
    tenancyStatus: "applicant",
  });

  it("preserves B's row, selection, and URL after A's direct-send refresh becomes stale", async () => {
    const aRefresh = deferred<unknown>();
    let inboxCalls = 0;
    const bThread = thread("b-thread", "Viewer B");
    const loader = vi.fn(async (options?: { force?: boolean }) => {
      inboxCalls += 1;
      if (options?.force) return aRefresh.promise;
      return activeViewerId === "viewer-b"
        ? { rows: [bThread], ok: true }
        : { rows: [], ok: true };
    });
    setupStorage(loader);
    const route = vi.fn();
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox
      tabId="unopened"
      commBase="/portal/communication"
      filterContacts={[contact("viewer-a")]}
      onRouteThreadChange={route}
    />);
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    screen.getByText("viewer-a contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    screen.getByTestId("direct-send-complete").click();

    activeViewerId = "viewer-b";
    view.rerender(<ManagerUnifiedInbox
      tabId="unopened"
      commBase="/portal/communication"
      filterContacts={[]}
      onRouteThreadChange={route}
    />);
    await waitFor(() => expect(screen.getByText("Viewer B")).toBeTruthy());
    screen.getByText("Viewer B").closest("button")?.click();
    await waitFor(() => expect(route).toHaveBeenLastCalledWith("b-thread"));
    const bUrlCallCount = route.mock.calls.length;
    const forcedCallsBeforeStaleCallback = loader.mock.calls.filter(([options]) => options?.force).length;
    firstDirectOnSent?.();
    await Promise.resolve();
    expect(loader.mock.calls.filter(([options]) => options?.force).length).toBe(forcedCallsBeforeStaleCallback);

    await act(async () => aRefresh.resolve({ rows: [], ok: false, stale: true }));
    await waitFor(() => expect(screen.getByText("Viewer B")).toBeTruthy());
    expect(screen.getByText("Viewer B").closest(".portal-inbox-row")?.className).toContain("selected");
    expect(route).toHaveBeenCalledTimes(bUrlCallCount);
    expect(inboxCalls).toBe(3);
  });

  it("rejects an old direct-send completion across A to B to A even when viewer ids repeat", async () => {
    const oldA = deferred<unknown>();
    const newA = deferred<unknown>();
    let aLoads = 0;
    const loader = vi.fn(async (options?: { force?: boolean }) => {
      if (options?.force) return oldA.promise;
      if (activeViewerId === "viewer-b") return { rows: [thread("b-thread", "Viewer B")], ok: true };
      aLoads += 1;
      if (aLoads === 1) return { rows: [], ok: true };
      return newA.promise;
    });
    setupStorage(loader);
    const route = vi.fn();
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[contact("viewer-a")]} onRouteThreadChange={route} />);
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    screen.getByText("viewer-a contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    screen.getByTestId("direct-send-complete").click();

    activeViewerId = "viewer-b";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[]} onRouteThreadChange={route} />);
    await waitFor(() => expect(screen.getByText("Viewer B")).toBeTruthy());
    screen.getByText("Viewer B").closest("button")?.click();
    activeViewerId = "viewer-a";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[contact("viewer-a")]} onRouteThreadChange={route} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
    await act(async () => newA.resolve({ rows: [thread("new-a-thread", "New A")], ok: true }));
    await waitFor(() => expect(screen.getByText("New A")).toBeTruthy());
    screen.getByText("New A").closest("button")?.click();
    const routeCount = route.mock.calls.length;
    await act(async () => oldA.resolve({ rows: [thread("old-a-thread", "Old A")], ok: false, stale: true }));
    expect(screen.getByText("New A")).toBeTruthy();
    expect(screen.queryByText("Old A")).toBeNull();
    expect(route).toHaveBeenCalledTimes(routeCount);
  });

  it("keeps the same-viewer rows and selection when direct-send refresh fails", async () => {
    const refresh = deferred<unknown>();
    const loader = vi.fn(async (options?: { force?: boolean }) => options?.force
      ? refresh.promise
      : { rows: [thread("existing", "Existing resident")], ok: true });
    setupStorage(loader);
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[contact("viewer-a")]} />);
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    screen.getByText("viewer-a contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    screen.getByTestId("direct-send-complete").click();
    await act(async () => refresh.resolve({ rows: [], ok: false }));
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    expect(screen.getByText("viewer-a contact").closest(".portal-inbox-row")?.className).toContain("selected");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("reveals a sent thread and resolves a directory-only placeholder after a successful refresh", async () => {
    const refresh = deferred<unknown>();
    const resident = contact("prospect");
    const sentThread = { ...thread("sent-prospect", "Prospect"), email: resident.email, folder: "sent" as const };
    const loader = vi.fn(async (options?: { force?: boolean }) => options?.force
      ? refresh.promise
      : { rows: [], ok: true });
    setupStorage(loader);
    const route = vi.fn();
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[resident]} onRouteThreadChange={route} />);
    await waitFor(() => expect(screen.getByText("prospect contact")).toBeTruthy());
    screen.getByText("prospect contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    await act(async () => latestDirectOnSent?.());
    await act(async () => refresh.resolve({ rows: [sentThread], ok: true }));
    await waitFor(() => expect(screen.getByText("prospect contact")).toBeTruthy());
    expect(route).toHaveBeenLastCalledWith("sent-prospect");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated direct-send completions into one follow-up refresh", async () => {
    const firstRefresh = deferred<unknown>();
    const followUp = deferred<unknown>();
    let forceCalls = 0;
    const loader = vi.fn(async (options?: { force?: boolean }) => {
      if (!options?.force) return { rows: [], ok: true };
      forceCalls += 1;
      return forceCalls === 1 ? firstRefresh.promise : followUp.promise;
    });
    setupStorage(loader);
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" filterContacts={[contact("viewer-a")]} />);
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    screen.getByText("viewer-a contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    await act(async () => {
      latestDirectOnSent?.();
      latestDirectOnSent?.();
      latestDirectOnSent?.();
    });
    await waitFor(() => expect(forceCalls).toBe(1));
    await act(async () => firstRefresh.resolve({ rows: [], ok: true }));
    await waitFor(() => expect(forceCalls).toBe(2));
    expect(forceCalls).toBe(2);
    await act(async () => followUp.resolve({ rows: [], ok: true }));
  });

  it("does not start a forced refresh when a retained A callback fires after B takes over", async () => {
    let forceCalls = 0;
    const loader = vi.fn(async (options?: { force?: boolean }) => {
      if (options?.force) forceCalls += 1;
      return { rows: [], ok: true };
    });
    setupStorage(loader);
    const route = vi.fn();
    const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
    const view = render(<ManagerUnifiedInbox
      tabId="unopened"
      commBase="/portal/communication"
      filterContacts={[contact("viewer-a")]}
      onRouteThreadChange={route}
    />);
    await waitFor(() => expect(screen.getByText("viewer-a contact")).toBeTruthy());
    screen.getByText("viewer-a contact").closest("button")?.click();
    await waitFor(() => expect(screen.getByTestId("direct-send-complete")).toBeTruthy());
    expect(firstDirectOnSent).toBeTypeOf("function");

    activeViewerId = "viewer-b";
    view.rerender(<ManagerUnifiedInbox
      tabId="unopened"
      commBase="/portal/communication"
      filterContacts={[contact("viewer-b")]}
      onRouteThreadChange={route}
    />);
    await waitFor(() => expect(screen.getByText("viewer-b contact")).toBeTruthy());
    const routeCount = route.mock.calls.length;
    firstDirectOnSent?.();
    await Promise.resolve();

    expect(forceCalls).toBe(0);
    expect(route).toHaveBeenCalledTimes(routeCount);
  });
});
