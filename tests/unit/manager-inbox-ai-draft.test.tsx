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
//     `aiDraft` hands its draft to the thread's own reply field — never a
//     second message box beside it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
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
const managerSession = vi.hoisted(() => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }));
const aiDraftPreference = vi.hoisted(() => ({ enabled: false }));
const draftPersistence = vi.hoisted(() => ({
  upsert: vi.fn(),
  succeeds: true,
  pending: null as Promise<boolean> | null,
}));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  syncPersistedInboxFromServerWithStatus: () => Promise.resolve({ rows: inboxRows, ok: true }),
  persistInbox: (_key: string, rows: typeof THREADS) => {
    inboxRows = rows;
    window.dispatchEvent(new CustomEvent("portal-inbox-changed", { detail: { key: "manager-inbox" } }));
  },
  persistInboxAwait: () => Promise.resolve(),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: (_key: string, rows: typeof THREADS) => {
    inboxRows = rows;
    window.dispatchEvent(new CustomEvent("portal-inbox-changed", { detail: { key: "manager-inbox" } }));
  },
  upsertPersistedInboxRows: (_key: string, _changed: unknown[], rows: typeof THREADS) => {
    inboxRows = rows;
    // Keep the spy's shape aligned with the real helper: key, changed rows,
    // and the complete snapshot are all part of the write contract.
    draftPersistence.upsert(_key, _changed, rows);
    window.dispatchEvent(new CustomEvent("portal-inbox-changed", { detail: { key: "manager-inbox" } }));
    return draftPersistence.pending ?? Promise.resolve(draftPersistence.succeeds);
  },
  deleteInboxThreadIds: () => Promise.resolve(true),
  inboxThreadSortMs: (id: string, t?: string) => {
    const m = String(id ?? "").match(/(\d{10,})/);
    if (m) return parseInt(m[1]!, 10);
    const p = Date.parse(t ?? "");
    return Number.isNaN(p) ? 0 : p;
  },
  inboxThreadMessages: () => [RESIDENT_MSG],
  inboxMessageOutbound: (_m: unknown, _i: number, folder: string) => folder === "sent",
  appendReplyToInboxThread: () => THREADS[0],
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => managerSession,
}));
vi.mock("@/hooks/use-inbox-ai-draft-auto-send", () => ({
  useInboxAiDraftAutoSend: () => ({
    enabled: aiDraftPreference.enabled,
    setEnabled: vi.fn(),
  }),
}));
vi.mock("@/lib/auth/portal-session-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-session-gate")>()),
  portalSessionViewerId: () => managerSession.userId,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
 useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/portal/payment-schedule-ui", () => ({ useScheduledPaymentMessages: () => ({ messages: [] }) }));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({ ManagerInboxSchedulePanel: () => null }));
vi.mock("@/lib/manager-inbox-contacts", async (importOriginal) => ({
  // Spread the real module: this file only needs an empty live directory, and a
  // hand-listed mock silently breaks every time the module gains an export a
  // component calls — which is exactly how this broke.
  ...(await importOriginal<typeof import("@/lib/manager-inbox-contacts")>()),
  buildManagerInboxLiveContacts: () => [],
}));
// AI drafts are deliberately gated OFF in demo mode; this is the real portal.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ManagerInbox } from "@/components/portal/pro-inbox";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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
    managerSession.userId = "mgr-1";
    managerSession.email = "mgr@example.com";
    managerSession.ready = true;
    aiDraftPreference.enabled = false;
    draftPersistence.succeeds = true;
    draftPersistence.pending = null;
    draftPersistence.upsert.mockClear();
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
    // …and the draft is adopted into the thread's OWN reply field rather than
    // a second message box beside it.
    const reply = await screen.findByDisplayValue(/I'll look into availability/);
    expect(reply.getAttribute("data-attr")).toBe("inbox-reply");
    // Adopting consumes the pending draft, so the AI affordance falls back to
    // the composer row's ✦ menu (round 3: Draft with AI lives there, not in a
    // pill above the field)…
    expect(await screen.findByRole("button", { name: "AI" })).toBeTruthy();
    expect(document.querySelector('[data-attr="inbox-composer-ai-menu"]')).not.toBeNull();
    // …and there is NO second message box: the legacy draft composer, its send
    // button, and its discard control are all gone.
    expect(document.querySelector('[data-attr="inbox-ai-draft"]')).toBeNull();
    expect(document.querySelector('[data-attr="inbox-ai-draft-send"]')).toBeNull();
    expect(screen.queryByLabelText("Discard draft")).toBeNull();
    expect(screen.queryByText("Approve & Send")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
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

    await screen.findByDisplayValue(/I’ll check the parking availability/);
    await waitFor(() => expect(screen.getByTestId("inbox-change-count").textContent).not.toBe("0"));
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Cannot update a component");
    consoleError.mockRestore();
  });

  it("rolls back a draft whose explicit upsert fails and surfaces the persistence error", async () => {
    inboxRows = [{ ...THREADS[0], unread: false, aiDraft: undefined }];
    draftPersistence.succeeds = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("inbox-draft-reply")
          ? Response.json({
              ok: true,
              draft: { text: "This draft must not survive.", status: "pending_approval" },
            })
          : Response.json({ ok: true }),
      ),
    );

    render(
      <ManagerInbox
        tabId="opened"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        controlledExpandedId="thr-2000000001"
      />,
    );

    // The internal persistence error is intentionally rendered as the same
    // safe, user-facing draft failure copy used for generation failures.
    expect(await screen.findByText("Couldn’t draft a reply.")).toBeTruthy();
    expect(document.querySelector('[data-attr="inbox-ai-draft-error"]')).not.toBeNull();
    expect(inboxRows[0]?.aiDraft).toBeUndefined();
    expect(draftPersistence.upsert).toHaveBeenCalled();
  });

  it("drops an old viewer's delayed draft completion before it can write into viewer B", async () => {
    // Keep viewer B's review-required draft in the explicit approval surface.
    // Otherwise the real draft card intentionally adopts it into the ordinary
    // composer, which is unrelated to the viewer-ownership boundary here.
    aiDraftPreference.enabled = true;
    inboxRows = [{ ...THREADS[0], unread: false, aiDraft: undefined }];
    const draftResponse = deferred<Response>();
    let draftRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("inbox-draft-reply")) {
          draftRequests += 1;
          return await draftResponse.promise;
        }
        return Response.json({ ok: true });
      }),
    );

    const view = render(
      <ManagerInbox
        tabId="opened"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        controlledExpandedId="thr-2000000001"
      />,
    );
    await waitFor(() => expect(draftRequests).toBe(1));

    managerSession.userId = "mgr-2";
    managerSession.email = "mgr-2@example.com";
    inboxRows = [{
      ...THREADS[0],
      id: "viewer-b-thread",
      from: "Viewer B resident",
      unread: false,
      aiDraft: { text: "Viewer B existing draft", status: "pending_approval", requiresReview: true },
    }];
    view.rerender(
      <ManagerInbox
        tabId="opened"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        controlledExpandedId="viewer-b-thread"
      />,
    );
    await screen.findByText("Viewer B resident");
    await screen.findByDisplayValue("Viewer B existing draft");

    // Hydration may have completed a persistence call before the viewer
    // changed. Isolate the stale completion from that setup work.
    draftPersistence.upsert.mockClear();
    await act(async () => draftResponse.resolve(Response.json({
      ok: true,
      draft: { text: "Viewer A delayed draft", status: "pending_approval" },
    })));

    expect(draftPersistence.upsert).not.toHaveBeenCalled();
    expect(inboxRows[0]?.id).toBe("viewer-b-thread");
    expect(inboxRows[0]?.aiDraft?.text).toBe("Viewer B existing draft");
    expect(screen.getByDisplayValue("Viewer B existing draft")).toBeInTheDocument();
  });

  it("removes only its failed draft contribution and preserves a newer queue entry and metadata", async () => {
    aiDraftPreference.enabled = true;
    const originalDraft = {
      text: "Original approval draft",
      status: "pending_approval" as const,
      requiresReview: true,
    };
    inboxRows = [{ ...THREADS[0], unread: false, aiDraft: undefined, aiDraftQueue: [] }];
    const draftResponse = deferred<Response>();
    const persisted = deferred<boolean>();
    draftPersistence.pending = persisted.promise;
    let draftRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("inbox-draft-reply")) {
        draftRequests += 1;
        return await draftResponse.promise;
      }
      return Response.json({ ok: true });
    }));

    render(
      <ManagerInbox
        tabId="opened"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        controlledExpandedId="thr-2000000001"
      />,
    );

    await waitFor(() => expect(draftRequests).toBe(1));
    inboxRows = [{ ...inboxRows[0]!, aiDraft: originalDraft, aiDraftQueue: [] }];
    await act(async () => draftResponse.resolve(Response.json({
      ok: true,
      draft: { text: "Generated draft", status: "pending_approval", requiresReview: true },
    })));
    await waitFor(() => expect(
      draftPersistence.upsert.mock.calls.some((call) => {
        const changed = call[1] as Array<{ aiDraft?: { text?: string } }>;
        return changed[0]?.aiDraft?.text === "Generated draft";
      }),
    ).toBe(true));
    expect(inboxRows[0]?.aiDraft).toMatchObject({
      text: "Generated draft",
      status: "pending_approval",
      requiresReview: true,
    });
    inboxRows = [{
      ...inboxRows[0]!,
      aiDraft: { ...inboxRows[0]!.aiDraft!, model: "newer-metadata" },
      aiDraftQueue: [
        ...(inboxRows[0]!.aiDraftQueue ?? []),
        { text: "Newer queued draft", status: "pending_approval", requiresReview: true },
      ],
    }];
    await act(async () => persisted.resolve(false));

    expect(inboxRows[0]?.aiDraft).toEqual({
      text: "Generated draft",
      status: "pending_approval",
      requiresReview: true,
      model: "newer-metadata",
    });
    expect(inboxRows[0]?.aiDraftQueue?.map((draft) => draft.text)).toContain("Newer queued draft");
  });
});
