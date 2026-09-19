// @vitest-environment jsdom
//
// Retained boundary coverage for the manager Communication surface. The list,
// person collapse, unified collapse, selected-source resolver, real read
// controller, reconciliation helper, and ResidentDirectChatPane are all real.
// Only unrelated composer/scheduling UI, session, and network boundaries are
// replaced so this catches regressions in the actual manager-to-pane wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type CapturedSmsRecipient = {
  phone?: string | null;
  residentEmail?: string | null;
  residentUserId?: string | null;
  conversationKey?: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  sms: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
  toast: vi.fn(),
  openedWrites: [] as string[],
  viewer: "manager-1",
  paneInputs: [] as Array<{ smsResident?: CapturedSmsRecipient | null; smsResidents?: CapturedSmsRecipient[] }>,
  emailPaneInputs: [] as Array<{ controlledExpandedId?: string; smsRecipients: CapturedSmsRecipient[] }>,
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
  loadManagerSmsConversationsClient: vi.fn(async () =>
    Response.json({ residents: state.sms, workNumber: "+12065550999" }),
  ),
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({
  loadManagerSmsArchivedIds: () => new Set<string>(),
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed",
}));
vi.mock("@/components/portal/communication-row-actions", () => ({ CommunicationRowActions: () => null }));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));
vi.mock("@/components/portal/pro-inbox", () => ({
  // An unbound email selects the real inbox's email-pane branch, not the
  // direct-chat branch. Keep it visible here so that boundary remains
  // observable without inventing a native member for that email.
  ManagerInbox: ({
    controlledExpandedId,
    smsRecipients = [],
  }: {
    controlledExpandedId?: string;
    smsRecipients?: CapturedSmsRecipient[];
  }) => {
    state.emailPaneInputs.push({ controlledExpandedId, smsRecipients });
    const thread = state.rows.find((row) => row.id === controlledExpandedId);
    return (
      <div data-testid="email-pane" data-email-active-id={controlledExpandedId}>
        {String(thread?.body ?? "Email conversation")}
      </div>
    );
  },
}));
vi.mock("@/components/portal/pro-sms-panel", () => ({ ManagerSmsPanel: () => null }));
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
vi.mock("@/lib/inbox-scheduled-thread", () => ({ scheduledItemsForRecipient: () => [] }));
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
vi.mock("@/lib/manager-inbox-reply-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-inbox-reply-channels")>();
  return { ...actual, resolveCommunicationPersonThreadReplyChannels: vi.fn(actual.resolveCommunicationPersonThreadReplyChannels) };
});
vi.mock("@/components/portal/pro-resident-detail-inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/pro-resident-detail-inbox")>();
  return {
    ...actual,
    ResidentDirectChatPane: (props: React.ComponentProps<typeof actual.ResidentDirectChatPane>) => {
      state.paneInputs.push(props);
      return <actual.ResidentDirectChatPane {...props} />;
    },
  };
});
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
  InboxComposer: () => null,
  AiDraftReplyCard: () => null,
  InboxReplyChannelPicker: () => null,
  InboxScheduledCard: () => null,
  InboxScheduledThreadList: () => null,
  InboxThreadView: ({
    title,
    messages,
    onBack,
  }: {
    title: string;
    messages: Array<{ id: string; body: string; attachments?: Array<{ name?: string }> }>;
    onBack?: () => void;
  }) => (
    <div data-testid="resident-thread">
      {onBack ? <button type="button" onClick={onBack}>Back</button> : null}
      <h2>{title}</h2>
      {messages.map((message) => (
        <div key={message.id} data-testid={`message-${message.id}`}>
          <span>{message.body}</span>
          {message.attachments?.map((attachment) => <span key={attachment.name}>{attachment.name}</span>)}
        </div>
      ))}
    </div>
  ),
}));

import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import {
  resolveCommunicationPersonThreadReplyChannels,
  resolveManagerInboxPortalRecipient,
  resolveManagerInboxSmsTarget,
} from "@/lib/manager-inbox-reply-channels";
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
  // The server proves this relationship before it emits the cross-channel
  // binding. The native fixture below carries the same owner/property/role.
  managerUserId: "manager-1",
  propertyId: "property-1",
  counterpartyRole: "resident",
  identityProvenance: [{
    managerUserId: "manager-1",
    propertyId: "property-1",
    counterpartyRole: "resident",
    smsConversationKey: key,
  }],
  smsConversationKey: key,
  smsBindingKeys: [key],
});

const sms = (key: string, body: string) => ({
  residentEmail: "resident@example.com",
  name: "Resident",
  phone: "+12065550142",
  conversationKey: key,
  residentUserId: `resident-${key.toLowerCase()}`,
  ownerManagerUserId: "manager-1",
  counterpartyRole: "resident",
  houses: [{ propertyId: "property-1", label: "Property 1", source: "manual" }],
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
  state.paneInputs = [];
  state.emailPaneInputs = [];
  state.viewer = "manager-1";
  state.post.mockImplementation(async (sources: Array<{ id: string }>) =>
    sources.map((source) => ({ id: source.id, status: "read", unread: false })),
  );
});

afterEach(() => {
  // Storage spies are installed by failure-path tests. Restore them here as a
  // final boundary too, so an assertion failure cannot poison the next case.
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("ManagerUnifiedInbox observed-read wiring", () => {
  it("collapses raw A/K1+B/K2 and renders only the explicitly bound native members", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    const list = await screen.findByTestId("manager-list");
    const emailRow = (await within(list).findByText("K1 NATIVE BODY")).closest("button");
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

    // Accepted native members remain available for a phone-addressed relay.
    // Portal delivery may derive its user id from that accepted target.
    const acceptedRecipients = state.paneInputs.at(-1)?.smsResidents ?? [];
    const phoneOnlyThread = { from: "+12065550142", email: "" };
    expect(resolveManagerInboxSmsTarget(phoneOnlyThread, acceptedRecipients, true)).toMatchObject({
      conversationKey: "K1",
      residentUserId: "resident-k1",
    });
    expect(resolveManagerInboxPortalRecipient(phoneOnlyThread, acceptedRecipients, true)).toEqual({
      toUserIds: ["resident-k1"],
    });
  });

  it("does not let email A's K1 binding display or acknowledge native K1 for unbound email B", async () => {
    state.rows = [
      { ...email("email-a", "EMAIL A BODY", "K1", "obs-a"), email: "a@example.com" },
      {
        ...email("email-b", "EMAIL B BODY", "K2", "obs-b"),
        email: "b@example.com",
        smsConversationKey: undefined,
        smsBindingKeys: undefined,
        identityProvenance: [{
          managerUserId: "manager-1",
          propertyId: "property-1",
          counterpartyRole: "resident",
        }],
      },
    ];
    state.sms = [{ ...sms("K1", "BORROWED K1 NATIVE BODY"), residentEmail: "b@example.com" }];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    expect(within(list).getByText("BORROWED K1 NATIVE BODY")).toBeTruthy();
    fireEvent.click((await within(list).findByText("EMAIL B BODY")).closest("button")!);

    const emailPane = await screen.findByTestId("email-pane");
    expect(within(emailPane).getByText("EMAIL B BODY")).toBeTruthy();
    expect(within(emailPane).queryByText("BORROWED K1 NATIVE BODY")).toBeNull();
    expect(screen.queryByTestId("resident-thread")).toBeNull();
    const emailPaneInput = state.emailPaneInputs.at(-1);
    expect(emailPaneInput).toMatchObject({ controlledExpandedId: "email-b", smsRecipients: [] });
    const emailB = state.rows.find((row) => row.id === "email-b")!;
    const emailBReplyIdentity = { from: String(emailB.from ?? ""), email: String(emailB.email ?? "") };
    expect(resolveManagerInboxSmsTarget(emailBReplyIdentity, emailPaneInput?.smsRecipients ?? [], true)).toBeNull();
    expect(resolveManagerInboxPortalRecipient(emailBReplyIdentity, emailPaneInput?.smsRecipients ?? [], true)).toEqual({
      toEmails: ["b@example.com"],
    });
    // The email pane owns its own acknowledgement. The unified native read
    // controller and reply resolver must not borrow A's K1 channel for B.
    expect(state.post).not.toHaveBeenCalled();
    expect(resolveCommunicationPersonThreadReplyChannels).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-1") ?? "[]"))
      .not.toContain("sms-k1");
  });

  it.each([
    ["array-only", undefined, ["K1", "K2"]],
    ["scalar plus array", "K1", ["K2"]],
  ] as const)("does not borrow archived %s ambiguous binding evidence for active unbound email B", async (_label, scalar, keys) => {
    const relationship = { managerUserId: "manager-1", propertyId: "property-1", counterpartyRole: "resident" };
    state.rows = [
      {
        ...email("email-a", "ARCHIVED AMBIGUOUS A BODY", "K1", "obs-a"),
        email: "b@example.com",
        folder: "trash",
        smsConversationKey: scalar,
        smsBindingKeys: [...keys],
        identityProvenance: [relationship],
      },
      {
        ...email("email-b", "ACTIVE UNBOUND B BODY", "", "obs-b"),
        email: "b@example.com",
        smsConversationKey: undefined,
        smsBindingKeys: undefined,
        identityProvenance: [relationship],
      },
    ];
    state.sms = [{ ...sms("K1", "BORROWED K1 NATIVE BODY"), residentEmail: "b@example.com" }];
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    expect(within(list).getByText("BORROWED K1 NATIVE BODY")).toBeTruthy();
    fireEvent.click((await within(list).findByText("ACTIVE UNBOUND B BODY")).closest("button")!);
    const emailPane = await screen.findByTestId("email-pane");
    expect(within(emailPane).getByText("ACTIVE UNBOUND B BODY")).toBeTruthy();
    expect(within(emailPane).queryByText("BORROWED K1 NATIVE BODY")).toBeNull();
    expect(within(emailPane).queryByText("ARCHIVED AMBIGUOUS A BODY")).toBeNull();
    expect(screen.queryByTestId("resident-thread")).toBeNull();
    const emailPaneInput = state.emailPaneInputs.at(-1);
    expect(emailPaneInput).toMatchObject({ controlledExpandedId: "email-b", smsRecipients: [] });
    const emailB = state.rows.find((row) => row.id === "email-b")!;
    const emailBReplyIdentity = { from: String(emailB.from ?? ""), email: String(emailB.email ?? "") };
    expect(resolveManagerInboxSmsTarget(emailBReplyIdentity, emailPaneInput?.smsRecipients ?? [], true)).toBeNull();
    expect(resolveManagerInboxPortalRecipient(emailBReplyIdentity, emailPaneInput?.smsRecipients ?? [], true)).toEqual({
      toEmails: ["b@example.com"],
    });
    expect(state.post).not.toHaveBeenCalled();
    expect(resolveCommunicationPersonThreadReplyChannels).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-1") ?? "[]")).not.toContain("sms-k1");
  });

  it("bounds persistent native storage failure, releases the held email attempt, and recovers on explicit reopen", async () => {
    const openedKey = "axis_manager_sms_opened_v2:manager-1";
    window.localStorage.setItem(openedKey, JSON.stringify(["unrelated-opened-id"]));
    const storedSetItem = Storage.prototype.setItem;
    const localStorageSetItem = vi.fn(() => {
      throw new Error("storage denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (this === window.localStorage) return localStorageSetItem();
      return storedSetItem.call(this, key, value);
    });
    let settleHeld!: (value: null) => void;
    const held = new Promise<null>((resolve) => { settleHeld = resolve; });
    state.post.mockReturnValueOnce(held);

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    fireEvent.click((await within(initialList).findByText("K1 NATIVE BODY")).closest("button")!);
    const thread = await screen.findByTestId("resident-thread");
    expect(within(thread).getByText("K2 NATIVE BODY")).toBeTruthy();
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
    expect(within(await screen.findByTestId("resident-thread")).getByText("K2 NATIVE BODY")).toBeTruthy();

    // A close/reopen is the explicit retry boundary. Once persistence recovers,
    // the unrelated receipt remains in the native store and the retry starts
    // exactly one fresh email attempt.
    setItem.mockRestore();
    state.post.mockImplementation(async (sources: Array<{ id: string }>) =>
      sources.map((source) => ({ id: source.id, status: "read", unread: false })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const list = await screen.findByTestId("manager-list");
    fireEvent.click((await within(list).findByText("K1 NATIVE BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(2));
    expect(window.localStorage.getItem(openedKey)).toContain("unrelated-opened-id");
    expect(window.localStorage.getItem(openedKey)).toContain("sms-k2");
    expect(state.toast.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("keeps confirmed reads after a successful open when a close/reopen POST returns null", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const initialList = await screen.findByTestId("manager-list");
    fireEvent.click((await within(initialList).findByText("K1 NATIVE BODY")).closest("button")!);
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(state.rows.every((row) => row.unread === false)).toBe(true);

    state.post.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const list = await screen.findByTestId("manager-list");
    fireEvent.click((await within(list).findByText("K1 NATIVE BODY")).closest("button")!);
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
    const storedGetItem = Storage.prototype.getItem;
    const localStorageGetItem = vi.fn(() => {
      throw new Error("storage read denied");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (key) {
      if (this === window.localStorage) return localStorageGetItem();
      return storedGetItem.call(this, key);
    });
    fireEvent.click((await within(initialList).findByText("K1 NATIVE BODY")).closest("button")!);
    expect(within(await screen.findByTestId("resident-thread")).getByText("K2 NATIVE BODY")).toBeTruthy();
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
      fireEvent.click((await within(initialList).findByText("K1 NATIVE BODY")).closest("button")!);
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
    const row = await within(list).findByText("K1 NATIVE BODY");
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
    const storedSetItem = Storage.prototype.setItem;
    const localStorageSetItem = vi.fn((key: string, value: string) =>
      storedSetItem.call(window.localStorage, key, value));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (this === window.localStorage) return localStorageSetItem(key, value);
      return storedSetItem.call(this, key, value);
    });
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    await waitForSmsConversations();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(state.post).not.toHaveBeenCalled();
    expect(localStorageSetItem).not.toHaveBeenCalled();

    fireEvent.click((await within(list).findByText("K1 NATIVE BODY")).closest("button")!);
    expect(within(await screen.findByTestId("resident-thread")).getByText("K2 NATIVE BODY")).toBeTruthy();
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
    fireEvent.click((await within(initialList).findByText("K1 NATIVE BODY")).closest("button")!);
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
