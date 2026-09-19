// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Portal = "manager" | "resident";
type InboxResult = { rows: ReturnType<typeof thread>[]; ok: boolean; stale?: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function thread(id: string, from: string) {
  return {
    id, from, email: `${id}@example.com`, folder: "inbox" as const,
    subject: "Conversation", preview: "Conversation", body: "Conversation",
    time: "Sep 19, 2026", unread: false,
  };
}

describe("initial Communication cache hydration", () => {
  let activeViewerId: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let applications: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/portal-inbox-storage");
    window.sessionStorage.clear();
    window.localStorage.clear();
    activeViewerId = "viewer-a";
    applications = vi.fn(async () => ({ rows: [], ok: true }));
    fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/lib/demo/demo-session", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
      isDemoModeActive: () => false,
    }));
    // Model usePortalSession's server fallback: ready + viewer are already
    // available while the real module-global cache identity is still null.
    vi.doMock("@/hooks/use-portal-session", () => ({
      usePortalSession: () => ({ userId: activeViewerId, email: `${activeViewerId}@example.com`, ready: true }),
    }));
    vi.doMock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
    vi.doMock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
    vi.doMock("@/lib/manager-applications-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
      syncManagerApplicationsFromServerWithStatus: (...args: unknown[]) => applications(...args),
      readManagerApplicationRows: () => [],
    }));
    vi.doMock("next/navigation", () => ({
      usePathname: () => "/resident/communication/active",
      useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
      useSearchParams: () => new URLSearchParams(),
    }));
    vi.doMock("@/components/providers/app-ui-provider", () => ({
      useOptionalAppUi: () => null, useConfirm: () => async () => true,
    }));
    vi.doMock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
    vi.doMock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => <div /> }));
    vi.doMock("@/components/portal/resident-inbox-panel", () => ({ ResidentInboxPanel: () => <div /> }));
    vi.doMock("@/components/portal/pro-sms-panel", () => ({ ManagerSmsPanel: () => <div />, smsOutboundPreviewPrefix: () => "" }));
    vi.doMock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div /> }));
    vi.doMock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => <div /> }));
    vi.doMock("@/components/portal/resident-manager-number-card", () => ({ ResidentManagerNumberCard: () => <div /> }));
    vi.doMock("@/components/portal/portal-contact-details-modal", () => ({ PortalContactDetailsModal: () => null }));
    vi.doMock("@/components/portal/communication-list-bulk-bar", () => ({ CommunicationListBulkBar: () => null }));
    vi.doMock("@/components/portal/pro-resident-detail-inbox", () => ({ ResidentDirectChatPane: () => <div /> }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function inboxElement(portal: Portal, smsUiEnabled = false) {
    if (portal === "manager") {
      const { ManagerUnifiedInbox } = await import("@/components/portal/pro-unified-inbox");
      return <ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled={smsUiEnabled} />;
    }
    const { ResidentCommunication } = await import("@/components/portal/resident-communication");
    return <ResidentCommunication residentUserId={activeViewerId} smsUiEnabled={smsUiEnabled} />;
  }

  function mockInboxStatus(loader: () => Promise<InboxResult>) {
    vi.doMock("@/lib/portal-inbox-storage", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
      loadPersistedInbox: () => [],
      stagePersistedInboxRows: () => {},
      syncPersistedInboxFromServerWithStatus: loader,
    }));
  }

  it.each(["manager", "resident"] as const)("recovers %s hydration with the real cache and one coalesced retry", async (portal) => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    let inboxCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/portal-inbox-threads?")) return ++inboxCalls === 1 ? first.promise : retry.promise;
      return Promise.resolve(Response.json({}));
    });
    const session = await import("@/lib/auth/portal-session-gate");
    expect(session.portalSessionViewerId()).toBeNull();
    render(await inboxElement(portal));
    await waitFor(() => expect(inboxCalls).toBe(1));
    // Same component viewer/ready values: no dependency change restarts it.
    await act(async () => {
      session.setPortalSessionViewer(activeViewerId);
      first.resolve(Response.json({ rows: [thread("stale", "Discarded hydration response")] }));
    });
    await waitFor(() => expect(inboxCalls).toBe(2));
    expect(screen.getByText("Loading conversations…")).toBeTruthy();
    expect(screen.queryByText("Discarded hydration response")).toBeNull();
    await act(async () => retry.resolve(Response.json({ rows: [thread("ready", "Hydrated conversation")] })));
    await waitFor(() => expect(screen.getByText("Hydrated conversation")).toBeTruthy());
    expect(screen.queryByText("Loading conversations…")).toBeNull();
    expect(inboxCalls).toBe(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sms-conversations"))).toBe(false);
    if (portal === "manager") expect(applications).toHaveBeenCalledTimes(1);
  });

  it.each(["manager", "resident"] as const)("ends repeated %s staleness in an error after exactly two calls", async (portal) => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const loader = vi.fn(async () => ({ rows: [thread("stale", "Never publish stale")], ok: false, stale: true }));
    mockInboxStatus(loader);
    render(await inboxElement(portal));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Loading conversations…")).toBeNull();
    expect(screen.queryByText("Never publish stale")).toBeNull();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    if (portal === "manager") expect(applications).toHaveBeenCalledTimes(1);
  });

  it.each(["manager", "resident"] as const)("does not reinterpret another cache viewer as the %s component viewer", async (portal) => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer("viewer-b");
    const loader = vi.fn(async () => ({ rows: [], ok: true }));
    mockInboxStatus(loader);
    render(await inboxElement(portal));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(loader).not.toHaveBeenCalled();
    expect(applications).not.toHaveBeenCalled();
  });

  it.each(["manager", "resident"] as const)("rejects a cache A-B-A cycle without a %s component rerender", async (portal) => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const response = deferred<Response>();
    let inboxCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/portal-inbox-threads?")) { inboxCalls += 1; return response.promise; }
      return Promise.resolve(Response.json({}));
    });
    render(await inboxElement(portal));
    await waitFor(() => expect(inboxCalls).toBe(1));
    await act(async () => {
      session.setPortalSessionViewer("viewer-b");
      session.setPortalSessionViewer(activeViewerId);
      response.resolve(Response.json({ rows: [thread("old-a", "Old A conversation")] }));
    });
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(inboxCalls).toBe(1);
    expect(screen.queryByText("Old A conversation")).toBeNull();
  });

  it.each(["manager", "resident"] as const)("ignores old %s completion while the new A generation is still loading", async (portal) => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const oldA = deferred<Response>();
    const viewerB = deferred<Response>();
    const newA = deferred<Response>();
    const responses = [oldA, viewerB, newA];
    let inboxCalls = 0;
    fetchMock.mockImplementation((url: string) => url.includes("/api/portal-inbox-threads?")
      ? responses[inboxCalls++].promise
      : Promise.resolve(Response.json({})));
    const view = render(await inboxElement(portal));
    await waitFor(() => expect(inboxCalls).toBe(1));
    activeViewerId = "viewer-b";
    session.setPortalSessionViewer(activeViewerId);
    view.rerender(await inboxElement(portal));
    await waitFor(() => expect(inboxCalls).toBe(2));
    activeViewerId = "viewer-a";
    session.setPortalSessionViewer(activeViewerId);
    view.rerender(await inboxElement(portal));
    await waitFor(() => expect(inboxCalls).toBe(3));
    await act(async () => {
      oldA.resolve(Response.json({ rows: [thread("old-a", "Old A conversation")] }));
      viewerB.resolve(Response.json({ rows: [thread("old-b", "Old B conversation")] }));
    });
    expect(screen.getByText("Loading conversations…")).toBeTruthy();
    expect(screen.queryByText("Could not load conversations.")).toBeNull();
    expect(inboxCalls).toBe(3);
    await act(async () => newA.resolve(Response.json({ rows: [thread("new-a", "Current A conversation")] })));
    await waitFor(() => expect(screen.getByText("Current A conversation")).toBeTruthy());
    expect(screen.queryByText("Old A conversation")).toBeNull();
    expect(screen.queryByText("Old B conversation")).toBeNull();
    expect(inboxCalls).toBe(3);
  });

  it.each(["manager", "resident"] as const)("does not reveal recovered %s email rows when enabled SMS fails", async (portal) => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const loader = vi.fn<() => Promise<InboxResult>>()
      .mockResolvedValueOnce({ rows: [], ok: false, stale: true })
      .mockResolvedValue({ rows: [thread("partial", "Partial email membership")], ok: true });
    mockInboxStatus(loader);
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("sms-conversations")) { smsCalls += 1; return Promise.resolve(new Response(null, { status: 403 })); }
      return Promise.resolve(Response.json({}));
    });
    render(await inboxElement(portal, true));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(screen.queryByText("Partial email membership")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(smsCalls).toBe(1);
  });

  it("retries only stale manager applications, retaining the successful inbox and SMS sources", async () => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const loader = vi.fn(async () => ({ rows: [thread("ready", "Ready email")], ok: true }));
    mockInboxStatus(loader);
    const retry = deferred<{ rows: []; ok: true }>();
    applications.mockResolvedValueOnce({ rows: [], ok: false, stale: true }).mockReturnValueOnce(retry.promise);
    let smsCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("sms-conversations")) { smsCalls += 1; return Promise.resolve(Response.json({ residents: [] })); }
      return Promise.resolve(Response.json({}));
    });
    render(await inboxElement("manager", true));
    await waitFor(() => expect(applications).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading conversations…")).toBeTruthy();
    expect(screen.queryByText("Ready email")).toBeNull();
    await act(async () => retry.resolve({ rows: [], ok: true }));
    await waitFor(() => expect(screen.getByText("Ready email")).toBeTruthy());
    expect(loader).toHaveBeenCalledTimes(1);
    expect(applications).toHaveBeenCalledTimes(2);
    expect(smsCalls).toBe(1);
  });

  it("keeps successful manager email hidden when applications remain stale after their bounded retry", async () => {
    const session = await import("@/lib/auth/portal-session-gate");
    session.setPortalSessionViewer(activeViewerId);
    const loader = vi.fn(async () => ({ rows: [thread("partial", "Partial manager membership")], ok: true }));
    mockInboxStatus(loader);
    applications.mockResolvedValue({ rows: [], ok: false, stale: true });
    render(await inboxElement("manager"));
    await waitFor(() => expect(screen.getByText("Could not load conversations.")).toBeTruthy());
    expect(screen.queryByText("Partial manager membership")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(applications).toHaveBeenCalledTimes(2);
  });
});
