// @vitest-environment jsdom
//
// Hydration and cache observation are read paths. They must never infer a
// delete from an empty or obsolete render snapshot. These tests deliberately
// use the real inbox storage and real panel so an ambient persistence effect
// cannot be hidden by a mocked child or mocked cache.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({
  userId: "resident-a" as string | null,
  email: "resident@example.com" as string | null,
  name: "Resident A" as string | null,
  ready: true,
}));

vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => sessionState,
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => sessionState,
}));

vi.mock("@/hooks/use-selected-workspace-id", () => ({
  useSelectedWorkspaceId: () => null,
}));

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));

vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [] }),
  patchScheduledMessage: vi.fn(),
}));

vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({
  ManagerInboxSchedulePanel: () => null,
}));

vi.mock("@/lib/manager-inbox-contacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-inbox-contacts")>()),
  buildManagerInboxLiveContacts: () => [],
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => async () => true,
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

vi.mock("@/components/portal/inbox-thread-assistant-strip", () => ({
  buildInboxThreadAssistantContext: () => ({}),
  InboxThreadAssistantStrip: () => null,
}));

import { ResidentInboxPanel } from "@/components/portal/resident-inbox-panel";
import { ManagerInbox } from "@/components/portal/pro-inbox";
import { VendorInboxPanel } from "@/components/portal/vendor-inbox-panel";
import {
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
  loadPersistedInbox,
  stagePersistedInboxRows,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import {
  markPortalSessionActive,
  setPortalSessionViewer,
} from "@/lib/auth/portal-session-gate";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function thread(id: string, from: string, folder: PersistedInboxThread["folder"] = "inbox"): PersistedInboxThread {
  return {
    id,
    folder,
    from,
    email: `${id}@example.com`,
    subject: `${from} subject`,
    preview: `${from} preview`,
    body: `${from} body`,
    time: "Sep 19, 10:00 AM",
    unread: folder === "inbox",
  };
}

function setViewer(userId: string) {
  sessionState.userId = userId;
  sessionState.email = `${userId}@example.com`;
  sessionState.name = userId;
  sessionState.ready = true;
  markPortalSessionActive();
  setPortalSessionViewer(userId);
}

function installFetch(
  inboxResponses: Array<Promise<Response> | Response>,
  respondToPost: (body: Record<string, unknown>) => Promise<Response> | Response = () =>
    Response.json({ ok: true, deleted: 1 }),
) {
  const inboxPosts: Array<Record<string, unknown>> = [];
  let inboxGet = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/portal-inbox-threads") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      inboxPosts.push(body);
      return await respondToPost(body);
    }
    if (url.includes("/api/portal-inbox-threads")) {
      const response = inboxResponses[Math.min(inboxGet, inboxResponses.length - 1)];
      inboxGet += 1;
      return await response;
    }
    return Response.json({ contacts: [], messages: [], threads: [], smsConfigured: false });
  }));
  return { inboxPosts, inboxGetCount: () => inboxGet };
}

function panel(tabId = "all") {
  return <ResidentInboxPanel tabId={tabId} embeddedInCommunication externalTitleActions />;
}

type InboxRole = "resident" | "manager" | "vendor";

const storageKeyFor = (role: InboxRole) => role === "manager"
  ? MANAGER_INBOX_STORAGE_KEY
  : role === "vendor"
    ? VENDOR_INBOX_STORAGE_KEY
    : RESIDENT_INBOX_STORAGE_KEY;

function rolePanel(role: InboxRole, controlledExpandedId?: string | null, tabId = "all") {
  if (role === "manager") {
    return <ManagerInbox
      tabId={tabId}
      embeddedInCommunication
      externalTitleActions
      suppressCompose
      suppressListPane={controlledExpandedId !== undefined}
      controlledExpandedId={controlledExpandedId}
      smsRecipients={[]}
    />;
  }
  if (role === "vendor") {
    return <VendorInboxPanel
      tabId={tabId}
      embeddedInCommunication
      externalTitleActions
      suppressListPane={controlledExpandedId !== undefined}
      controlledExpandedId={controlledExpandedId}
    />;
  }
  return <ResidentInboxPanel
    tabId={tabId}
    embeddedInCommunication
    externalTitleActions
    suppressListPane={controlledExpandedId !== undefined}
    controlledExpandedId={controlledExpandedId}
  />;
}

describe("inbox panel hydration is viewer-owned and read-only", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setPortalSessionViewer(null);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setPortalSessionViewer(null);
  });

  it.each(["resident", "manager", "vendor"] as const)(
    "keeps the newest %s A cache across an A-B-A cycle and a late first-A completion",
    async (role) => {
    const firstA = deferred<Response>();
    const viewerB = deferred<Response>();
    const secondA = deferred<Response>();
    const network = installFetch([firstA.promise, viewerB.promise, secondA.promise]);
    const storageKey = storageKeyFor(role);

    setViewer(`${role}-a`);
    const view = render(rolePanel(role));
    await waitFor(() => expect(network.inboxGetCount()).toBe(1));

    await act(async () => {
      setViewer(`${role}-b`);
      view.rerender(rolePanel(role));
    });
    const bRow = thread("b-current", "Viewer B current");
    act(() => stagePersistedInboxRows(storageKey, [bRow]));
    await waitFor(() => expect(network.inboxGetCount()).toBe(2));
    await act(async () => viewerB.resolve(Response.json({ rows: [bRow] })));
    await screen.findByText("Viewer B current");

    await act(async () => {
      setViewer(`${role}-a`);
      view.rerender(rolePanel(role));
    });
    const newestA = thread("a-current", "Viewer A current");
    act(() => stagePersistedInboxRows(storageKey, [newestA]));
    await waitFor(() => expect(network.inboxGetCount()).toBe(3));
    await act(async () => secondA.resolve(Response.json({ rows: [newestA] })));
    await screen.findByText("Viewer A current");

    await act(async () => firstA.resolve(Response.json({ rows: [] })));
    expect(screen.getByText("Viewer A current")).toBeTruthy();
    expect(loadPersistedInbox(storageKey, []).map((row) => row.id)).toEqual(["a-current"]);
    expect(network.inboxPosts).toEqual([]);
    },
  );

  it.each(["resident", "manager", "vendor"] as const)(
    "hides %s viewer A while B is pending or failed and accepts B's later cache event",
    async (role) => {
      const oldA = deferred<Response>();
      const failedB = deferred<Response>();
      const network = installFetch([oldA.promise, failedB.promise]);
      const storageKey = storageKeyFor(role);
      const aRow = thread(`${role}-a-row`, `${role} viewer A`);

      setViewer(`${role}-a`);
      stagePersistedInboxRows(storageKey, [aRow]);
      const view = render(rolePanel(role));
      await screen.findByText(`${role} viewer A`);
      await waitFor(() => expect(network.inboxGetCount()).toBe(1));

      await act(async () => {
        setViewer(`${role}-b`);
        view.rerender(rolePanel(role));
      });
      expect(screen.queryByText(`${role} viewer A`)).toBeNull();
      await waitFor(() => expect(network.inboxGetCount()).toBe(2));
      await act(async () => failedB.resolve(new Response(null, { status: 503 })));
      expect(screen.queryByText(`${role} viewer A`)).toBeNull();

      const bRow = thread(`${role}-b-row`, `${role} viewer B`);
      act(() => stagePersistedInboxRows(storageKey, [bRow]));
      await screen.findByText(`${role} viewer B`);

      await act(async () => oldA.resolve(Response.json({ rows: [] })));
      expect(screen.getByText(`${role} viewer B`)).toBeTruthy();
      expect(loadPersistedInbox(storageKey, []).map((row) => row.id)).toEqual([`${role}-b-row`]);
      expect(network.inboxPosts).toEqual([]);
    },
  );

  it.each(["resident", "manager", "vendor"] as const)(
    "reconciles a failed %s read action without discarding a newer cache event",
    async (role) => {
      const failedWrite = deferred<Response>();
      const storageKey = storageKeyFor(role);
      const original = thread(`${role}-read-row`, `${role} read owner`);
      const network = installFetch(
        [Response.json({ rows: [original] })],
        () => failedWrite.promise,
      );

      setViewer(`${role}-read`);
      stagePersistedInboxRows(storageKey, [original]);
      render(rolePanel(role, original.id));
      await waitFor(() => expect(network.inboxPosts.length).toBeGreaterThan(0));

      const concurrent = { ...original, unread: false, preview: "Newer event preview" };
      const sibling = thread(`${role}-event-row`, `${role} event sibling`);
      act(() => stagePersistedInboxRows(storageKey, [concurrent, sibling]));
      await act(async () => failedWrite.resolve(new Response(null, { status: 503 })));

      await waitFor(() => {
        const rows = loadPersistedInbox(storageKey, []);
        expect(rows.map((row) => row.id)).toEqual([original.id, sibling.id]);
        expect(rows[0]?.preview).toBe("Newer event preview");
        expect(rows[0]?.unread).toBe(true);
      });
      expect(screen.getByText(`${role} event sibling`)).toBeTruthy();
    },
  );

  it.each(["resident", "manager", "vendor"] as const)(
    "does not roll a delayed failed %s read action from viewer A into viewer B",
    async (role) => {
      const failedWrite = deferred<Response>();
      const storageKey = storageKeyFor(role);
      const aRow = thread(`${role}-delayed-read`, `${role} viewer A read`);
      const bRow = thread(`${role}-action-b-row`, `${role} viewer B after action`);
      const network = installFetch(
        [Response.json({ rows: [aRow] }), Response.json({ rows: [bRow] })],
        () => failedWrite.promise,
      );

      setViewer(`${role}-action-a`);
      stagePersistedInboxRows(storageKey, [aRow]);
      const view = render(rolePanel(role, aRow.id));
      await waitFor(() => expect(network.inboxPosts.length).toBeGreaterThan(0));

      await act(async () => {
        setViewer(`${role}-action-b`);
        stagePersistedInboxRows(storageKey, [bRow]);
        view.rerender(rolePanel(role));
      });
      await screen.findByText(`${role} viewer B after action`);

      await act(async () => failedWrite.resolve(new Response(null, { status: 503 })));
      expect(screen.getByText(`${role} viewer B after action`)).toBeTruthy();
      expect(loadPersistedInbox(storageKey, []).map((row) => row.id)).toEqual([bRow.id]);
    },
  );

  it.each(["resident", "manager", "vendor"] as const)(
    "rolls back only the failed %s archive fields and preserves newer cache data",
    async (role) => {
      const failedArchive = deferred<Response>();
      const storageKey = storageKeyFor(role);
      const original = { ...thread(`${role}-archive-row`, `${role} archive owner`), unread: false };
      const network = installFetch(
        [Response.json({ rows: [original] })],
        (body) => body.action === "upsert" ? failedArchive.promise : Response.json({ ok: true }),
      );

      setViewer(`${role}-archive-owner`);
      stagePersistedInboxRows(storageKey, [original]);
      render(rolePanel(role, original.id));
      fireEvent.click(await screen.findByRole("button", { name: /archive conversation|archive/i }));
      await waitFor(() => expect(network.inboxPosts.some((body) => body.action === "upsert")).toBe(true));

      const optimistic = loadPersistedInbox(storageKey, [])[0]!;
      const newer = { ...optimistic, preview: "Newer archive-time message", body: "Newer body", unread: true };
      const sibling = thread(`${role}-archive-sibling`, `${role} archive sibling`);
      act(() => stagePersistedInboxRows(storageKey, [newer, sibling]));
      await act(async () => failedArchive.resolve(new Response(null, { status: 503 })));

      await waitFor(() => {
        const rows = loadPersistedInbox(storageKey, []);
        expect(rows.map((row) => row.id)).toEqual([original.id, sibling.id]);
        expect(rows[0]).toMatchObject({ folder: "inbox", preview: "Newer archive-time message", body: "Newer body", unread: true });
      });
      expect(screen.getByText(`${role} archive sibling`)).toBeTruthy();
    },
  );

  it("does not publish or persist a completion after unmount", async () => {
    const pending = deferred<Response>();
    const network = installFetch([pending.promise]);
    setViewer("resident-unmounted");
    const current = thread("survives-unmount", "Survives unmount");
    stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [current]);

    const view = render(panel());
    await waitFor(() => expect(network.inboxGetCount()).toBe(1));
    view.unmount();
    await act(async () => pending.resolve(Response.json({ rows: [] })));

    expect(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []).map((row) => row.id)).toEqual(["survives-unmount"]);
    expect(network.inboxPosts).toEqual([]);
  });

  it.each(["resident", "manager", "vendor"] as const)(
    "keeps the remounted %s viewer current when the prior mount completes late",
    async (role) => {
      const firstMount = deferred<Response>();
      const remount = deferred<Response>();
      const network = installFetch([firstMount.promise, remount.promise]);
      const storageKey = storageKeyFor(role);
      setViewer(`${role}-remount`);
      const stale = thread(`${role}-stale-mount`, `${role} stale mount`);
      stagePersistedInboxRows(storageKey, [stale]);

      const first = render(rolePanel(role));
      await waitFor(() => expect(network.inboxGetCount()).toBe(1));
      first.unmount();

      const current = thread(`${role}-current-remount`, `${role} current remount`);
      stagePersistedInboxRows(storageKey, [current]);
      render(rolePanel(role));
      await waitFor(() => expect(network.inboxGetCount()).toBe(2));
      await act(async () => remount.resolve(Response.json({ rows: [current] })));
      await screen.findByText(`${role} current remount`);

      await act(async () => firstMount.resolve(Response.json({ rows: [] })));
      expect(screen.getByText(`${role} current remount`)).toBeTruthy();
      expect(loadPersistedInbox(storageKey, []).map((row) => row.id)).toEqual([current.id]);
      expect(network.inboxPosts).toEqual([]);
    },
  );

  it("accepts a successful empty snapshot without persisting it", async () => {
    const pending = deferred<Response>();
    const network = installFetch([pending.promise]);
    setViewer("resident-empty");
    render(panel());

    await waitFor(() => expect(network.inboxGetCount()).toBe(1));
    await act(async () => pending.resolve(Response.json({ rows: [] })));
    await screen.findByText("No messages yet.");
    expect(network.inboxPosts).toEqual([]);
  });

  it.each([
    ["malformed success", Response.json({ rows: { unexpected: true } })],
    ["failed response", new Response(null, { status: 503 })],
  ])("preserves a usable snapshot after a %s without persisting it", async (_label, response) => {
    const pending = deferred<Response>();
    const network = installFetch([pending.promise]);
    setViewer(`resident-${String(_label).replaceAll(" ", "-")}`);
    const usable = thread("usable-snapshot", "Usable snapshot");
    stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [usable]);
    render(panel());
    await screen.findByText("Usable snapshot");
    await waitFor(() => expect(network.inboxGetCount()).toBe(1));

    await act(async () => pending.resolve(response));
    expect(screen.getByText("Usable snapshot")).toBeTruthy();
    expect(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []).map((row) => row.id)).toEqual(["usable-snapshot"]);
    expect(network.inboxPosts).toEqual([]);
  });

  it("still sends deleteIds for an explicit permanent-delete click", async () => {
    setViewer("resident-delete");
    const archived = thread("delete-me", "Delete me", "trash");
    stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [archived]);
    const network = installFetch([
      Response.json({ rows: [archived] }),
      Response.json({ rows: [] }),
    ]);
    render(panel("trash"));

    const deleteButton = await screen.findByRole("button", { name: "Delete forever" });
    expect(network.inboxPosts).toEqual([]);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(network.inboxPosts.some((body) => body.action === "deleteIds" &&
        Array.isArray(body.ids) && body.ids.includes("delete-me"))).toBe(true);
    });
  });

  it.each(["resident", "manager", "vendor"] as const)(
    "does not let a delayed %s permanent delete replace the next viewer's cache",
    async (role) => {
      const deleteResponse = deferred<Response>();
      const storageKey = storageKeyFor(role);
      const archivedA = thread(`${role}-delete-a`, `${role} delete A`, "trash");
      const currentB = thread(`${role}-delete-b`, `${role} viewer B current`);
      const network = installFetch(
        [Response.json({ rows: [archivedA] }), Response.json({ rows: [currentB] })],
        (body) => body.action === "deleteIds"
          ? deleteResponse.promise
          : Response.json({ ok: true }),
      );

      setViewer(`${role}-delete-owner-a`);
      stagePersistedInboxRows(storageKey, [archivedA]);
      const view = render(rolePanel(role, archivedA.id, "trash"));
      const deleteButton = await screen.findByRole("button", { name: /delete (forever|conversation)/i });
      fireEvent.click(deleteButton);
      await waitFor(() => expect(network.inboxPosts.some((body) => body.action === "deleteIds")).toBe(true));

      await act(async () => {
        setViewer(`${role}-delete-owner-b`);
        stagePersistedInboxRows(storageKey, [currentB]);
        view.rerender(rolePanel(role, undefined, "all"));
      });
      await screen.findByText(`${role} viewer B current`);
      const postsBeforeCompletion = network.inboxPosts.length;

      await act(async () => deleteResponse.resolve(Response.json({ ok: true, deleted: 1 })));

      expect(screen.getByText(`${role} viewer B current`)).toBeTruthy();
      expect(loadPersistedInbox(storageKey, []).map((row) => row.id)).toEqual([currentB.id]);
      expect(network.inboxPosts).toHaveLength(postsBeforeCompletion);
    },
  );
});
