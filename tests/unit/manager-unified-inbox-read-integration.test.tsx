// @vitest-environment jsdom
//
// Retained boundary coverage for the manager Communication surface. The list,
// person collapse, unified collapse, selected-source resolver, real read
// controller, reconciliation helper, and ResidentDirectChatPane are all real.
// Only unrelated composer/scheduling UI, session, and network boundaries are
// replaced so this catches regressions in the actual manager-to-pane wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  sms: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
  toast: vi.fn(),
  openedWrites: [] as string[],
  viewer: "manager-1",
  detail: vi.fn(),
  list: vi.fn(),
  patch: vi.fn(),
  replySms: false,
}));

vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: state.viewer, email: `${state.viewer}@example.com`, ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useOptionalAppUi: () => ({ showToast: state.toast }),
  useAppUi: () => ({ showToast: state.toast }),
}));
vi.mock("@/lib/portal-communication-nav", () => ({
  clearCommunicationThreadUrl: vi.fn(),
  selectCommunicationThreadUrl: vi.fn(),
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerApplicationsFromServerWithStatus: vi.fn(async () => ({ rows: [], ok: true })),
}));
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  invalidateManagerSmsConversationsClient: vi.fn(),
  loadManagerSmsConversationsClient: vi.fn((...args: unknown[]) => state.list(...args)),
  loadManagerSmsConversationDetailClient: (...args: unknown[]) => state.detail(...args),
  updateManagerSmsConversationStateClient: (...args: unknown[]) => state.patch(...args),
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({
  loadManagerSmsArchivedIds: () => new Set<string>(),
  mirrorManagerSmsArchivedFromServer: vi.fn(),
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
vi.mock("@/components/portal/communication-row-actions", () => ({ CommunicationRowActions: () => null }));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));
vi.mock("@/components/portal/pro-inbox", () => ({ ManagerInbox: () => null }));
vi.mock("@/components/portal/pro-sms-panel", () => ({ ManagerSmsPanel: ({ controlledActiveId }: { controlledActiveId?: string }) => <div data-testid="sms-thread" data-id={controlledActiveId} /> }));
vi.mock("@/components/portal/portal-contact-details-modal", () => ({
  PortalContactDetailsModal: () => null,
}));
vi.mock("@/hooks/use-unified-communication-bulk", () => ({
  useUnifiedCommunicationBulk: () => ({
    selection: { clearSelection: vi.fn(), toggleSelected: vi.fn() },
    editOpen: false,
    setEditOpen: vi.fn(),
    editInitial: null,
    saveEdit: vi.fn(async () => true),
    editSaving: false,
    editError: null,
    handleArchive: vi.fn(async () => true),
    handleDelete: vi.fn(async () => true),
  }),
}));
vi.mock("@/lib/portal-api-error", () => ({ readPortalApiError: vi.fn(async () => "error") }));
vi.mock("@/lib/inbox-scheduled-thread", () => ({
  scheduledItemsForRecipient: () => [],
  automationChannelDefaultsFromSettings: () => undefined,
}));
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [], reload: vi.fn() }),
  patchScheduledMessage: vi.fn(),
}));
vi.mock("@/components/portal/portal-inbox-selection", () => ({
  sendAutomationScheduledMessageNow: vi.fn(),
  sendManualScheduledMessageNow: vi.fn(),
}));
vi.mock("@/components/portal/portal-message-compose-fields", () => ({
  defaultScheduleSendAtLocal: () => "2026-09-13T12:00",
}));
vi.mock("@/components/portal/inbox-thread-assistant-strip", () => ({
  InboxThreadAssistantStrip: () => null,
  buildInboxThreadAssistantContext: () => "",
}));
vi.mock("@/lib/assistant-inbox-reply", () => ({ sendPropLaneAssistantInboxMessage: vi.fn() }));
vi.mock("@/lib/inbox-attachments", () => ({
  INBOX_MAX_ATTACHMENTS: 5,
  createPendingInboxAttachment: vi.fn(),
  revokeInboxAttachmentPreview: vi.fn(),
  uploadInboxAttachment: vi.fn(),
}));
vi.mock("@/lib/manager-inbox-reply-channels", () => ({
  hasInboxReplyChannelSelected: ({ viaProplane, viaSms, viaEmail }: { viaProplane: boolean; viaSms: boolean; viaEmail: boolean }) => viaProplane || viaSms || viaEmail,
  resolveCommunicationPersonThreadReplyChannels: () => ({
    viaProplane: !state.replySms,
    viaEmail: false,
    viaSms: state.replySms,
  }),
}));
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersistedInbox: () => state.rows,
  syncPersistedInboxFromServerWithStatus: vi.fn(async () => ({ rows: state.rows, ok: true })),
  stagePersistedInboxRows: vi.fn((_key: string, rows: Array<Record<string, unknown>>) => {
    state.rows = rows;
  }),
  markPersistedInboxSourcesRead: vi.fn((_key: string, sources: unknown[]) => state.post(sources)),
}));
vi.mock("@/components/portal/portal-inbox-ui", () => ({
  INBOX_LIST_SCROLL: "",
  PORTAL_INBOX_LIST_TOOLBAR_CLASS: "",
  INBOX_THREAD_ICON_BTN: "",
  INBOX_THREAD_ICON_BTN_DANGER: "",
  PortalInboxEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  CommunicationInboxInitialState: () => <div>Loading</div>,
  InboxConversationListAddRow: () => null,
  InboxListSegmentTabs: () => null,
  InboxThreadEmpty: ({ title }: { title: string }) => <div>{title}</div>,
  InboxThreadSkeleton: () => <div data-testid="inbox-thread-skeleton">Loading conversation…</div>,
  InboxTwoPane: ({ list, thread }: { list: React.ReactNode; thread: React.ReactNode }) => (
    <div data-testid="manager-two-pane"><div data-testid="manager-list">{list}</div><div data-testid="manager-thread">{thread}</div></div>
  ),
  InboxConversationRow: ({
    name,
    preview,
    selected,
    onOpen,
  }: {
    name: string;
    preview: string;
    selected?: boolean;
    onOpen: () => void;
  }) => (
    <button type="button" data-testid={`conversation-${name}`} aria-pressed={selected} onClick={onOpen}>
      <span>{name}</span><span>{preview}</span>
    </button>
  ),
  InboxComposer: ({ onSubmit, onChange, disabled }: { onSubmit: () => void; onChange: (value: string) => void; disabled?: boolean }) => <><input aria-label="Reply" onChange={(event) => onChange(event.target.value)} /><button type="button" disabled={disabled} onClick={onSubmit}>Send reply</button></>,
  AiDraftReplyCard: () => null,
  InboxReplyChannelPicker: () => null,
  InboxScheduledCard: () => null,
  InboxScheduledThreadList: () => null,
  InboxThreadView: ({
    title,
    messages,
    beforeMessages,
    composer,
    onBack,
  }: {
    title: string;
    messages: Array<{ id: string; body: string; attachments?: Array<{ name?: string }> }>;
    beforeMessages?: React.ReactNode;
    composer?: React.ReactNode;
    onBack?: () => void;
  }) => (
    <div data-testid="resident-thread">
      {onBack ? <button type="button" onClick={onBack}>Back</button> : null}
      <h2>{title}</h2>
      {beforeMessages}
      {messages.map((message) => (
        <div key={message.id} data-testid={`message-${message.id}`}>
          <span>{message.body}</span>
          {message.attachments?.map((attachment) => <span key={attachment.name}>{attachment.name}</span>)}
        </div>
      ))}
      {composer}
    </div>
  ),
}));

import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { loadManagerSmsConversationsClient } from "@/lib/manager-sms-conversations-client";

const email = (id: string, body: string, key: string, observation: string) => ({
  id,
  folder: "inbox" as const,
  from: "Resident",
  email: "resident@example.com",
  subject: body,
  preview: body,
  body,
  time: id === "email-a" ? "Sep 13, 2026 12:00 PM" : "Sep 13, 2026 12:01 PM",
  unread: true,
  attachments: [{ url: `/files/${id}.pdf`, name: `${id}.pdf` }],
  readSources: [{ id, observation, unread: true }],
  readSourcesComplete: true,
  smsConversationKey: key,
  smsBindingKeys: [key],
});

describe("merged projection transcript", () => {
  it("discards a delayed detail response from an earlier A-B-A viewer session", async () => {
    const old = deferred<Response>();
    const resident = { ...sms("K1", "CURRENT PREVIEW"), projectionId: "projection-one", unread: false, stateVersion: 0 };
    state.rows = [email("email-a", "EMAIL BODY", "K1", "obs-a")];
    state.sms = [resident];
    state.detail.mockReturnValueOnce(old.promise).mockImplementation(async () => Response.json({ resident, messages: [{ id: "fresh", direction: "inbound", body: "FRESH SESSION", createdAt: "2026-09-13T18:03:00.000Z" }], nextCursor: null }));
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await within(await screen.findByTestId("manager-list")).findByText("CURRENT PREVIEW")).closest("button")!);
    await waitFor(() => expect(state.detail).toHaveBeenCalledTimes(1));
    state.viewer = "viewer-b";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    state.viewer = "manager-1";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const row = await within(await screen.findByTestId("manager-list")).findByText("CURRENT PREVIEW");
    fireEvent.click(row.closest("button")!);
    await within(await screen.findByTestId("resident-thread")).findByText("FRESH SESSION");
    old.resolve(Response.json({ resident, messages: [{ id: "stale", direction: "inbound", body: "STALE SESSION", createdAt: "2026-09-13T18:02:00.000Z" }], nextCursor: null }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText("STALE SESSION")).toBeNull();
  });

  it("does not acknowledge an inbound until its exact detail rendered", async () => {
    const resident = { ...sms("K1", "NEW PREVIEW"), projectionId: "projection-one", unread: true, stateVersion: 0 };
    state.rows = [email("email-a", "EMAIL BODY", "K1", "obs-a")];
    state.sms = [resident];
    state.detail.mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }));
    state.detail.mockImplementation(async () => Response.json({ resident, messages: [{ id: "observed-inbound", direction: "inbound", body: "RENDERED INBOUND", createdAt: "2026-09-13T18:03:00.000Z" }], nextCursor: null }));
    state.patch.mockResolvedValue(Response.json({ ok: true, version: 1 }));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await within(await screen.findByTestId("manager-list")).findByText("NEW PREVIEW")).closest("button")!);
    await screen.findByText("Unavailable");
    expect(state.patch).not.toHaveBeenCalled();
    state.sms = [{ ...resident, messages: [{ ...resident.messages[0], id: "observed-inbound" }] }];
    fireEvent(window, new Event("axis:manager-sms-contacts-changed"));
    await within(await screen.findByTestId("resident-thread")).findByText("RENDERED INBOUND");
    await waitFor(() => expect(state.patch).toHaveBeenCalledWith(expect.objectContaining({ projectionId: "projection-one", observed: { id: "observed-inbound", occurredAt: "2026-09-13T18:03:00.000Z" } })));
  });

  it("requires an exact choice for two bound lines and refuses a retired line", async () => {
    const user = userEvent.setup();
    state.replySms = true;
    state.rows = [{ ...email("email-a", "SAVED EMAIL", "K1", "obs-a"), smsBindingKeys: ["K1", "K2"] }];
    const first = { ...sms("K1", "LINE ONE"), projectionId: "projection-one", workLineId: "line-one", counterpartyRole: "resident", unread: false, stateVersion: 0 };
    const second = { ...sms("K2", "LINE TWO"), projectionId: "projection-two", workLineId: "line-two", counterpartyRole: "applicant", unread: false, stateVersion: 0 };
    state.sms = [first, second];
    state.detail.mockImplementation(async (id: string) => Response.json({ resident: id === "projection-one" ? first : second, messages: id === "projection-one" ? first.messages : second.messages, nextCursor: null }));
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "/api/manager/sms-conversations" && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true, status: "sent" });
      }
      return Response.json({ messages: [] });
    }));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const row = await within(await screen.findByTestId("manager-list")).findByText("SAVED EMAIL");
    fireEvent.click(row.closest("button")!);
    const thread = await screen.findByTestId("resident-thread");
    await within(thread).findByText("LINE ONE");
    expect(within(thread).getByRole("button", { name: "Send reply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(thread).getByRole("button", { name: "Text line" }));
    const secondLine = await screen.findByRole("option", { name: /applicant/ });
    secondLine.focus();
    await user.keyboard("{Enter}");
    expect(within(thread).getByRole("button", { name: "Text line" }).textContent).toContain("applicant");
    fireEvent.change(within(thread).getByRole("textbox", { name: "Reply" }), { target: { value: "The chosen line" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.projectionId).toBe("projection-two");
    state.sms = [first, { ...second, sendDisabled: true, stateVersion: 1 }];
    state.detail.mockImplementation(async (id: string) => Response.json({ resident: id === "projection-one" ? first : { ...second, sendDisabled: true }, messages: id === "projection-one" ? first.messages : second.messages, nextCursor: null }));
    fireEvent(window, new Event("axis:manager-sms-contacts-changed"));
    await waitFor(() => expect(within(thread).getByRole("button", { name: "Send reply" }).hasAttribute("disabled")).toBe(true));
    expect(sent).toHaveLength(1);
  });
  it("loads 101 selected turns, retains older pages across latest refresh, and sends on the selected work line", async () => {
    state.replySms = true;
    const turns = Array.from({ length: 101 }, (_, index) => ({
      id: `turn-${index + 1}`,
      direction: "inbound" as const,
      body: `TEXT TURN ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 8, 13, 18, 0, index + 1)).toISOString(),
    }));
    const resident = { ...sms("K1", "TEXT TURN 101"), projectionId: "projection-one", workLineId: "line-one", messages: [turns[100]], unread: false, stateVersion: 0 };
    state.rows = [email("email-a", "SAVED EMAIL", "K1", "obs-a")];
    state.sms = [resident];
    state.detail.mockImplementation(async (_id: string, before?: string) => Response.json({
      resident,
      messages: before === "older-2" ? turns.slice(0, 1) : before === "older-1" ? turns.slice(1, 51) : turns.slice(-50),
      nextCursor: before === "older-2" ? null : before === "older-1" ? "older-2" : "older-1",
    }));
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "/api/manager/sms-conversations" && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ ok: true, status: "sent" });
      }
      return Response.json({ messages: [] });
    }));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const row = await within(await screen.findByTestId("manager-list")).findByText("TEXT TURN 101");
    fireEvent.click(row.closest("button")!);
    const thread = await screen.findByTestId("resident-thread");
    await within(thread).findByText("TEXT TURN 101");
    expect(within(thread).getByText("SAVED EMAIL")).toBeTruthy();
    fireEvent.click(within(thread).getByText("Load earlier texts"));
    await within(thread).findByText("TEXT TURN 2");
    fireEvent.click(within(thread).getByText("Load earlier texts"));
    await within(thread).findByText("TEXT TURN 1");
    expect(within(thread).queryByText("Load earlier texts")).toBeNull();
    fireEvent.change(within(thread).getByRole("textbox", { name: "Reply" }), { target: { value: "Selected line reply" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.projectionId).toBe("projection-one");
    await waitFor(() => expect(within(thread).getByText("TEXT TURN 1")).toBeTruthy());
    expect(within(thread).queryByText("Load earlier texts")).toBeNull();
    turns.push({ id: "turn-102", direction: "inbound", body: "TEXT TURN 102", createdAt: new Date(Date.UTC(2026, 8, 13, 18, 1, 42)).toISOString() });
    state.sms = [{ ...resident, messages: [turns[101]] }];
    fireEvent(window, new Event("axis:manager-sms-contacts-changed"));
    await within(thread).findByText("TEXT TURN 102");
    expect(within(thread).getByText("TEXT TURN 1")).toBeTruthy();
    expect(within(thread).queryByText("Load earlier texts")).toBeNull();
  });
});

describe("routed SMS and list continuation", () => {
  it("clears a previously selected thread when the next routed link is revoked", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const resident = { ...sms("K1", "PRIVATE BODY"), projectionId: id, residentEmail: null, unread: false };
    state.rows = [];
    state.sms = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).includes("revoked")
      ? Response.json({ error: "Conversation not found." }, { status: 404 })
      : Response.json({ resident, messages: resident.messages, nextCursor: null })));
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled routeThreadId="old-notice" />);
    await waitFor(() => expect(screen.getByTestId("sms-thread").getAttribute("data-id")).toBe(id));
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled routeThreadId="revoked" />);
    await screen.findByText("Conversation not found.");
    expect(screen.queryByTestId("sms-thread")).toBeNull();
  });

  it("opens an authorized page-two projection and canonicalizes an old alias without list membership", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const resident = { ...sms("K1", "OLDER PROJECTED BODY"), projectionId: id, residentEmail: null, unread: false };
    state.rows = [];
    state.sms = [];
    const routeChanged = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => String(url).includes("/api/manager/sms-conversations/old-notice")
      ? Response.json({ resident, messages: resident.messages, nextCursor: null })
      : Response.json({})));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled routeThreadId="old-notice" onRouteThreadChange={routeChanged} />);
    await waitFor(() => expect(screen.getByTestId("sms-thread").getAttribute("data-id")).toBe(id));
    expect(routeChanged).toHaveBeenCalledWith(id);
  });

  it.each([[409, "ambiguous"], [404, "not found"]])("shows an honest %s routed-link result", async (status, text) => {
    state.rows = [];
    state.sms = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: text }, { status })));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled routeThreadId="old-notice" />);
    await waitFor(() => expect(screen.getByText(new RegExp(text, "i"))).toBeTruthy());
    expect(screen.queryByTestId("inbox-thread-skeleton")).toBeNull();
  });

  it("retains the oldest list cursor through a first-page poll", async () => {
    state.rows = [];
    const row = (id: string) => ({ ...sms(id, `BODY ${id}`), projectionId: id, residentEmail: null, name: `Person ${id}`, unread: false });
    const seen: Array<string | null> = [];
    let firstPoll = false;
    state.list.mockImplementation(async (_viewer: string, _force: boolean, _workspace: string | null, cursor?: string | null) => {
      seen.push(cursor ?? null);
      if (cursor === "page-two") return Response.json({ residents: [row("two")], nextCursor: "page-three" });
      if (cursor === "page-three") return Response.json({ residents: [row("three")], nextCursor: null });
      if (firstPoll) return Response.json({ residents: [row("new")], nextCursor: "changed-first-page" });
      return Response.json({ residents: [row("one")], nextCursor: "page-two" });
    });
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click(await screen.findByText("Load more conversations"));
    await screen.findByText("Person two");
    firstPoll = true;
    fireEvent(window, new Event("axis:manager-sms-contacts-changed"));
    await screen.findByText("Person new");
    expect(screen.getByText("Person one")).toBeTruthy();
    expect(screen.getByText("Person two")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more conversations"));
    await screen.findByText("Person three");
    expect(screen.getByText("Person one")).toBeTruthy();
    expect(screen.getByText("Person two")).toBeTruthy();
    expect(seen).toEqual([null, "page-two", null, "page-three"]);
    expect(screen.queryByText("Load more conversations")).toBeNull();
  });

  it("drops a selected projection when its unchanged summary loses detail authorization on poll", async () => {
    state.rows = [email("email-a", "SAVED EMAIL", "K1", "obs-a")];
    const resident = { ...sms("K1", "REVOKED PREVIEW"), projectionId: "projection-revoked",
      residentEmail: "resident@example.com", unread: false, stateVersion: 0 };
    state.sms = [resident];
    state.detail.mockImplementation(async () => Response.json({ resident,
      messages: [{ id: "old-original", direction: "inbound", body: "OLD PRIVATE ORIGINAL", createdAt: "2026-09-13T18:03:00.000Z" }], nextCursor: null }));
    let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async () => revoked
      ? Response.json({ error: "not found" }, { status: 404 })
      : Response.json({ resident, messages: [] })));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await within(await screen.findByTestId("manager-list")).findByText("REVOKED PREVIEW")).closest("button")!);
    await within(await screen.findByTestId("resident-thread")).findByText("OLD PRIVATE ORIGINAL");
    revoked = true;
    state.sms = [];
    fireEvent(window, new Event("axis:manager-sms-contacts-changed"));
    await waitFor(() => expect(screen.queryByText("OLD PRIVATE ORIGINAL")).toBeNull());
    expect(screen.queryByText("REVOKED PREVIEW")).toBeNull();
  });
});

const sms = (key: string, body: string) => ({
  residentEmail: "resident@example.com",
  name: "Resident",
  phone: "+12065550142",
  conversationKey: key,
  messages: [{
    id: `sms-${key.toLowerCase()}`,
    direction: "inbound" as const,
    body,
    createdAt: "2026-09-13T18:02:00.000Z",
  }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function waitForSmsConversations() {
  await waitFor(() => expect(loadManagerSmsConversationsClient).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  state.rows = [
    email("email-a", "EMAIL A BODY", "K1", "obs-a"),
    email("email-b", "EMAIL B BODY", "K2", "obs-b"),
  ];
  state.sms = [sms("K1", "K1 NATIVE BODY"), sms("K2", "K2 NATIVE BODY"), sms("K3", "UNRELATED K3 BODY")];
  state.openedWrites = [];
  state.viewer = "manager-1";
  state.replySms = false;
  state.detail.mockReset();
  state.patch.mockReset();
  state.list.mockReset().mockImplementation(async () => Response.json({ residents: state.sms, workNumber: "+12065550999" }));
  state.post.mockImplementation(async (sources: Array<{ id: string }>) =>
    sources.map((source) => ({ id: source.id, status: "read", unread: false })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Storage spies sit on Storage.prototype under jsdom; never let one outlive
  // a test whose assertion threw before its inline mockRestore().
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/**
 * Spy where the method actually lives. Node's built-in `localStorage` defines
 * its methods on the instance; jsdom's `Storage` keeps them on the prototype,
 * and assigning an own `setItem` there is swallowed by its named-item handling.
 */
function storageMethodOwner(method: "getItem" | "setItem"): Storage {
  const storage = window.localStorage;
  return Object.prototype.hasOwnProperty.call(storage, method) ? storage : (Object.getPrototypeOf(storage) as Storage);
}

describe("ManagerUnifiedInbox observed-read wiring", () => {
  it("collapses raw A/K1+B/K2 and renders only the explicitly bound native members", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    const list = await screen.findByTestId("manager-list");
    const emailRow = (await within(list).findByText("EMAIL B BODY")).closest("button");
    expect(emailRow).toBeTruthy();
    fireEvent.click(emailRow!);

    const thread = await screen.findByTestId("resident-thread");
    expect(within(thread).getByText("EMAIL A BODY")).toBeTruthy();
    expect(within(thread).getByText("EMAIL B BODY")).toBeTruthy();
    expect(within(thread).getByText("K1 NATIVE BODY")).toBeTruthy();
    expect(within(thread).getByText("K2 NATIVE BODY")).toBeTruthy();
    expect(within(thread).queryByText("UNRELATED K3 BODY")).toBeNull();

    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    expect(state.post.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: "email-a", observation: "obs-a" }),
      expect.objectContaining({ id: "email-b", observation: "obs-b" }),
    ]);
    expect(state.post.mock.calls[0]?.[0]).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-1") ?? "[]")).toEqual(
      expect.arrayContaining(["sms-k1", "sms-k2"]),
    );
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-1") ?? "[]")).not.toContain("sms-k3");
  });

  it("bounds persistent native storage failure, releases the held email attempt, and recovers on explicit reopen", async () => {
    const openedKey = "axis_manager_sms_opened_v2:manager-1";
    window.localStorage.setItem(openedKey, JSON.stringify(["unrelated-opened-id"]));
    const localStorageSetItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    const setItem = vi.spyOn(storageMethodOwner("setItem"), "setItem").mockImplementation(localStorageSetItem);
    let settleHeld!: (value: null) => void;
    const held = new Promise<null>((resolve) => { settleHeld = resolve; });
    state.post.mockReturnValueOnce(held);

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    fireEvent.click((await within(initialList).findByText("EMAIL B BODY")).closest("button")!);
    const thread = await screen.findByTestId("resident-thread");
    expect(within(thread).getByText("K1 NATIVE BODY")).toBeTruthy();
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(localStorageSetItem).toHaveBeenCalledTimes(1));
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledTimes(1);

    // Settle the already-started request with a recoverable failure. The
    // optimistic email state must release, while the native failure remains a
    // bounded visible attempt.
    await act(async () => { settleHeld(null); });
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    expect(state.toast.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(state.toast.mock.calls.length).toBeLessThanOrEqual(2);
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(within(await screen.findByTestId("resident-thread")).getByText("K1 NATIVE BODY")).toBeTruthy();

    // A close/reopen is the explicit retry boundary. Once persistence recovers,
    // the unrelated receipt remains in the native store and the retry starts
    // exactly one fresh email attempt.
    setItem.mockRestore();
    state.post.mockImplementation(async (sources: Array<{ id: string }>) =>
      sources.map((source) => ({ id: source.id, status: "read", unread: false })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const list = await screen.findByTestId("manager-list");
    fireEvent.click((await within(list).findByText("EMAIL B BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(2));
    expect(window.localStorage.getItem(openedKey)).toContain("unrelated-opened-id");
    expect(window.localStorage.getItem(openedKey)).toContain("sms-k1");
    expect(state.toast.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps confirmed reads after a successful open when a close/reopen POST returns null", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    fireEvent.click((await within(initialList).findByText("EMAIL B BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(state.rows.every((row) => row.unread === false)).toBe(true);

    state.post.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const list = await screen.findByTestId("manager-list");
    fireEvent.click((await within(list).findByText("EMAIL B BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(state.rows.every((row) => row.unread === false)).toBe(true);
    expect(state.rows.flatMap((row) => (row.readSources as Array<{ unread?: boolean }> | undefined) ?? [])
      .every((source) => source.unread === false)).toBe(true);
  });

  it("preserves initialized native receipts through a visible getItem exception without retry looping", async () => {
    const openedKey = "axis_manager_sms_opened_v2:manager-1";
    window.localStorage.setItem(openedKey, JSON.stringify(["existing-opened-id"]));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    const localStorageGetItem = vi.fn(() => {
      throw new Error("storage read denied");
    });
    const getItem = vi.spyOn(storageMethodOwner("getItem"), "getItem").mockImplementation(localStorageGetItem);
    fireEvent.click((await within(initialList).findByText("EMAIL B BODY")).closest("button")!);
    expect(within(await screen.findByTestId("resident-thread")).getByText("K1 NATIVE BODY")).toBeTruthy();
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await waitFor(() => expect(localStorageGetItem).toHaveBeenCalled());
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.toast.mock.calls.length).toBeLessThanOrEqual(1);
    getItem.mockRestore();
    expect(window.localStorage.getItem(openedKey)).toContain("existing-opened-id");
  });

  it.each(["success", "failure"] as const)(
    "opens a native arrival while the email request is pending and keeps one request on %s settlement",
    async (outcome) => {
      const held = deferred<Array<{ id: string; status: "read"; unread: boolean }>>();
      state.post.mockReturnValue(held.promise);
      render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
      const initialList = await screen.findByTestId("manager-list");
      fireEvent.click((await within(initialList).findByText("EMAIL B BODY")).closest("button")!);
      await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));

      state.sms = state.sms.map((conversation, index) => index === 1
        ? {
            ...conversation,
            messages: [
              ...((conversation.messages as Array<Record<string, unknown>> | undefined) ?? []),
              {
                id: "sms-k2-arrival",
                direction: "inbound" as const,
                body: "NATIVE ARRIVAL WHILE EMAIL PENDING",
                createdAt: "2026-09-13T18:03:00.000Z",
              },
            ],
          }
        : conversation);
      await act(async () => {
        window.dispatchEvent(new Event("axis:manager-sms-contacts-changed"));
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getAllByText("NATIVE ARRIVAL WHILE EMAIL PENDING").length).toBeGreaterThan(0));
      expect(state.post).toHaveBeenCalledTimes(1);

      if (outcome === "success") {
        held.resolve([{ id: "email-a", status: "read", unread: false }, { id: "email-b", status: "read", unread: false }]);
      } else {
        held.resolve(null as never);
      }
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(state.post).toHaveBeenCalledTimes(1);
      expect(state.toast.mock.calls.length).toBeLessThanOrEqual(outcome === "failure" ? 2 : 1);
    },
  );

  it("defers a hidden manager pane until visible and acknowledges exactly once", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    const row = await within(list).findByText("EMAIL B BODY");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent.click(row.closest("button")!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(state.post).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
  });

  it("keeps the hidden mobile thread pane from acknowledging until the user opens it", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const storedSetItem = window.localStorage.setItem.bind(window.localStorage);
    const localStorageSetItem = vi.fn((key: string, value: string) => storedSetItem(key, value));
    const setItem = vi.spyOn(storageMethodOwner("setItem"), "setItem").mockImplementation(localStorageSetItem);
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(state.post).not.toHaveBeenCalled();
    expect(localStorageSetItem).not.toHaveBeenCalled();

    fireEvent.click((await within(list).findByText("EMAIL B BODY")).closest("button")!);
    expect(within(await screen.findByTestId("resident-thread")).getByText("K1 NATIVE BODY")).toBeTruthy();
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(localStorageSetItem).toHaveBeenCalledTimes(1));
    setItem.mockRestore();
  });

  it("ignores a stale A settlement after A-B-A viewer authority changes", async () => {
    const held = deferred<null>();
    state.post.mockImplementationOnce(() => held.promise);
    state.post.mockImplementation(async (sources: Array<{ id: string }>) =>
      sources.map((source) => ({ id: source.id, status: "read", unread: false })),
    );
    const view = render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    fireEvent.click((await within(initialList).findByText("EMAIL B BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    const before = state.rows.map((row) => ({
      id: row.id,
      body: row.body,
      preview: row.preview,
    }));
    const toastCount = state.toast.mock.calls.length;

    state.viewer = "viewer-b";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    state.viewer = "manager-1";
    view.rerender(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    held.resolve(null);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(state.rows.map((row) => ({ id: row.id, body: row.body, preview: row.preview }))).toEqual(before);
    expect(state.toast.mock.calls.length).toBe(toastCount);
  });
});
