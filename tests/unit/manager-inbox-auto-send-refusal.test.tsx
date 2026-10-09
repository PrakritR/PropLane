// @vitest-environment jsdom
//
// Screen J: the auto-send loop. A phone-only conversation (no email, no portal
// account) with a pending AI draft and "AI draft auto-send" on used to default
// to In-app, throw "not reachable in the PropLane app yet" on every attempt,
// and - because the failed attempt cleared its own latch and the approving
// state flip re-ran the effect - retry and toast without end.
//
// Now: In-app is not offered to that person, the composer defaults to the
// channel they used (text), and a refused send is attempted once and toasted
// once; it only retries on a user action.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";

const MSG = {
  id: "thr-2000000002-root",
  from: "+12065550100",
  body: "Is the room still open?",
  at: "Oct 8, 2026, 9:00 AM",
};
const AI_DRAFT = { text: "Yes, it is still open. Want to tour?", status: "pending_approval" };

const THREADS = [
  {
    id: "thr-2000000002",
    folder: "inbox",
    from: "+12065550100",
    email: "",
    subject: "Text from +12065550100",
    preview: MSG.body,
    body: MSG.body,
    time: "Oct 8, 2026",
    unread: true,
    smsNoticePhone: "+12065550100",
    rootOutbound: false,
    aiDraft: AI_DRAFT,
  },
];

let inboxRows: Array<Record<string, unknown>> = THREADS;
const showToast = vi.fn();

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
  inboxThreadMessages: () => [MSG],
  inboxMessageOutbound: (_m: unknown, _i: number, folder: string) => folder === "sent",
  appendReplyToInboxThread: (row: Record<string, unknown>) => row,
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/payment-schedule-ui", () => ({ useScheduledPaymentMessages: () => ({ messages: [] }) }));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({ ManagerInboxSchedulePanel: () => null }));
vi.mock("@/lib/manager-inbox-contacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-inbox-contacts")>()),
  buildManagerInboxLiveContacts: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

const autoSendEnabled = { current: false };
vi.mock("@/hooks/use-inbox-ai-draft-auto-send", () => ({
  useInboxAiDraftAutoSend: () => ({
    enabled: autoSendEnabled.current,
    setEnabled: (next: boolean) => {
      autoSendEnabled.current = next;
    },
  }),
}));

import { ManagerInbox } from "@/components/portal/pro-inbox";

afterEach(() => cleanup());

const PHONE_ONLY_RECIPIENT = [
  { phone: "+12065550100", residentEmail: null, residentUserId: null, conversationKey: null },
];

/** The work number can send (SMS UI flag off, as shipped), so a text reply is live. */
function okResponse(url: string) {
  if (url.includes("/api/manager/messaging-number")) {
    return new Response(JSON.stringify({ canSend: true, number: { phoneNumber: "+12065559999" } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function renderInbox(threadId = "thr-2000000002") {
  return render(
    <ManagerInbox
      tabId="unopened"
      embeddedInCommunication
      externalTitleActions
      suppressCompose
      suppressListPane
      commBase="/portal/communication"
      controlledExpandedId={threadId}
      smsRecipients={PHONE_ONLY_RECIPIENT}
    />,
  );
}

describe("a refused auto-send does not loop", () => {
  afterEach(() => {
    inboxRows = THREADS;
    autoSendEnabled.current = false;
    showToast.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("phone-only thread, auto-send on, text refused: one send attempt and one toast", async () => {
    autoSendEnabled.current = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/manager/sms-conversations") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Texting is paused for this number." }), { status: 409 });
      }
      return okResponse(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderInbox();
    await screen.findByDisplayValue(AI_DRAFT.text);

    // Let the effect, the refusal, the approving-state flip and any retries play out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    const smsSends = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).includes("/api/manager/sms-conversations") && init?.method === "POST",
    );
    expect(smsSends).toHaveLength(1);
    // It went out on the channel the person used - never an in-app attempt.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/portal/send-inbox-message")),
    ).toBe(false);
    const refusals = showToast.mock.calls.filter(([message]) => /Texting is paused/.test(String(message)));
    expect(refusals).toHaveLength(1);
    expect(
      showToast.mock.calls.some(([message]) => /not reachable in the PropLane app/.test(String(message))),
    ).toBe(false);
  });

  it("does not offer In-app for the phone-only person", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => okResponse(String(input))));
    renderInbox();
    await screen.findByDisplayValue(AI_DRAFT.text);
    await waitFor(() => {
      expect(document.body.textContent).not.toMatch(/In-app/);
    });
  });

  it("generates no client draft for an SMS thread the server agent answers", async () => {
    const draftless: Record<string, unknown> = {
      ...THREADS[0]!,
      id: "thr-2000000003",
      threadType: "claw_leasing_sms",
    };
    delete draftless.aiDraft;
    inboxRows = [draftless];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => okResponse(String(input)));
    vi.stubGlobal("fetch", fetchMock);

    renderInbox("thr-2000000003");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/api/portal/inbox-draft-reply")),
    ).toBe(false);
  });

  it("still drafts for a thread no server agent answers (control)", async () => {
    const plain: Record<string, unknown> = { ...THREADS[0]!, id: "thr-2000000004" };
    delete plain.aiDraft;
    inboxRows = [plain];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => okResponse(String(input)));
    vi.stubGlobal("fetch", fetchMock);

    renderInbox("thr-2000000004");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/portal/inbox-draft-reply")),
      ).toBe(true);
    });
  });
});
