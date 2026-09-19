// @vitest-environment jsdom
// Boundary coverage for the real ManagerUnifiedInbox selection path. The
// shell/persistence edges are mocked; list folding, row selection, selected
// SMS resolution, timeline rendering, and read acknowledgement stay real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  sms: [] as Array<Record<string, unknown>>,
  archivedSms: new Set<string>(),
  post: vi.fn(),
  sendPropLane: vi.fn(),
  replyChannels: { viaProplane: true, viaEmail: false, viaSms: false },
}));

vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "manager-a", email: "manager-a@example.com", ready: true }) }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useOptionalAppUi: () => ({ showToast: vi.fn() }), useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/portal-communication-nav", () => ({ clearCommunicationThreadUrl: vi.fn(), selectCommunicationThreadUrl: vi.fn() }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "axis:manager-applications",
  syncManagerApplicationsFromServerWithStatus: vi.fn(async () => ({ rows: [], ok: true })),
}));
vi.mock("@/lib/manager-sms-conversations-client", () => ({
  invalidateManagerSmsConversationsClient: vi.fn(),
  loadManagerSmsConversationsClient: vi.fn(async () => Response.json({ residents: state.sms, workNumber: "+12065550999" })),
}));
vi.mock("@/lib/manager-sms-archive.client", () => ({ loadManagerSmsArchivedIds: () => state.archivedSms, MANAGER_SMS_ARCHIVE_CHANGED_EVENT: "manager-sms-archive-changed" }));
vi.mock("@/components/portal/communication-row-actions", () => ({ CommunicationRowActions: () => null }));
vi.mock("@/components/portal/pro-work-number-card", () => ({ ManagerWorkNumberCard: () => null }));
vi.mock("@/components/portal/pro-inbox", () => ({
  ManagerInbox: ({ controlledExpandedId }: { controlledExpandedId?: string }) => {
    const thread = state.rows.find((row) => row.id === controlledExpandedId);
    return <div data-testid="email-pane" data-email-active-id={controlledExpandedId}>{String(thread?.body ?? "Email conversation")}</div>;
  },
}));
vi.mock("@/components/portal/pro-sms-panel", () => ({
  // A native-only row selects the SMS branch of the real unified inbox. Keep
  // this pane contract-visible so the fixture proves the body and active id.
  ManagerSmsPanel: ({ controlledActiveId }: { controlledActiveId?: string }) => {
    const conversation = state.sms.find((item) => item.conversationKey === controlledActiveId);
    const body = (conversation?.messages as Array<{ body?: string }> | undefined)?.[0]?.body;
    return <div data-testid="native-pane" data-native-active-id={controlledActiveId}>{body ?? "Native conversation"}</div>;
  },
}));
vi.mock("@/components/portal/portal-contact-details-modal", () => ({ PortalContactDetailsModal: () => null }));
vi.mock("@/hooks/use-unified-communication-bulk", () => ({
  useUnifiedCommunicationBulk: () => ({ selection: { clearSelection: vi.fn(), toggleSelected: vi.fn() }, editOpen: false, setEditOpen: vi.fn(), editInitial: null, saveEdit: vi.fn(async () => true), editSaving: false, editError: null, handleArchive: vi.fn(async () => true), handleDelete: vi.fn(async () => true) }),
}));
vi.mock("@/lib/portal-api-error", () => ({ readPortalApiError: vi.fn(async () => "error") }));
vi.mock("@/lib/inbox-scheduled-thread", () => ({ scheduledItemsForRecipient: () => [] }));
vi.mock("@/components/portal/payment-schedule-ui", () => ({ useScheduledPaymentMessages: () => ({ messages: [], reload: vi.fn() }), patchScheduledMessage: vi.fn() }));
vi.mock("@/components/portal/portal-inbox-selection", () => ({ sendAutomationScheduledMessageNow: vi.fn(), sendManualScheduledMessageNow: vi.fn() }));
vi.mock("@/components/portal/portal-message-compose-fields", () => ({ defaultScheduleSendAtLocal: () => "2026-09-18T12:00" }));
vi.mock("@/components/portal/inbox-thread-assistant-strip", () => ({ InboxThreadAssistantStrip: () => null, buildInboxThreadAssistantContext: () => "" }));
vi.mock("@/lib/assistant-inbox-reply", () => ({ sendPropLaneAssistantInboxMessage: state.sendPropLane }));
vi.mock("@/lib/inbox-attachments", () => ({ INBOX_MAX_ATTACHMENTS: 5, createPendingInboxAttachment: vi.fn(), revokeInboxAttachmentPreview: vi.fn(), uploadInboxAttachment: vi.fn() }));
vi.mock("@/lib/manager-inbox-reply-channels", () => ({
  hasInboxReplyChannelSelected: () => true,
  resolveCommunicationPersonThreadReplyChannels: () => state.replyChannels,
}));
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPersistedInbox: () => state.rows,
  syncPersistedInboxFromServerWithStatus: vi.fn(async () => ({ rows: state.rows, ok: true })),
  stagePersistedInboxRows: vi.fn(),
  markPersistedInboxSourcesRead: vi.fn((_key: string, sources: unknown[]) => state.post(sources)),
}));
vi.mock("@/components/portal/portal-inbox-ui", () => ({
  INBOX_LIST_SCROLL: "", PORTAL_INBOX_LIST_TOOLBAR_CLASS: "", INBOX_THREAD_ICON_BTN: "", INBOX_THREAD_ICON_BTN_DANGER: "",
  CommunicationInboxInitialState: () => <div>Loading</div>,
  InboxListSegmentTabs: () => null,
  InboxThreadEmpty: ({ title }: { title: string }) => <div>{title}</div>,
  InboxThreadSkeleton: () => <div>Loading conversation…</div>,
  InboxTwoPane: ({ list, thread }: { list: React.ReactNode; thread: React.ReactNode }) => <div><div data-testid="manager-list">{list}</div><div data-testid="manager-thread">{thread}</div></div>,
  InboxConversationRow: ({ name, preview, selected, onOpen }: { name: string; preview: string; selected?: boolean; onOpen: () => void }) => <button type="button" data-testid={`manager-conversation-row-${preview}`} aria-pressed={selected} onClick={onOpen}><span>{name}</span><span>{preview}</span></button>,
  InboxComposer: ({ value, onChange, onSubmit, disabled }: { value: string; onChange: (value: string) => void; onSubmit: () => void; disabled?: boolean }) => <div data-testid="manager-composer"><input aria-label="Reply" value={value} onChange={(event) => onChange(event.target.value)} /><button type="button" data-testid="manager-send" disabled={disabled} onClick={onSubmit}>Send</button></div>,
  AiDraftReplyCard: () => null, InboxReplyChannelPicker: () => null, InboxScheduledCard: () => null, InboxScheduledThreadList: () => null,
  InboxThreadView: ({ title, messages, composer }: { title: string; messages: Array<{ id: string; body: string }>; composer?: React.ReactNode }) => <div data-testid="thread"><h2>{title}</h2>{messages.map((message) => <div key={message.id}>{message.body}</div>)}{composer}</div>,
}));

import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";

function email(id: string, propertyId: string, binding: string, role = "applicant"): Record<string, unknown> {
  return { id, folder: "inbox", from: "Applicant", email: "same@example.com", subject: id, preview: id, body: `${id} email`, time: "Sep 18, 10:00 AM", unread: true, managerUserId: "manager-a", propertyId, counterpartyRole: role, smsConversationKey: binding, smsBindingKeys: [binding], readSources: [{ id, observation: `obs-${id}`, unread: true }], readSourcesComplete: true };
}

function sms(key: string, propertyIds: string[], body: string, role = "applicant"): Record<string, unknown> {
  return { residentEmail: "same@example.com", name: "Applicant", phone: "+12065550142", conversationKey: key, ownerManagerUserId: "manager-a", counterpartyRole: role, propertyLabel: propertyIds.join(","), houses: propertyIds.map((propertyId) => ({ propertyId, label: propertyId, source: "manual" })), messages: [{ id: `message-${key}`, direction: "inbound", body, createdAt: "2026-09-18T18:02:00.000Z" }] };
}

async function clickManagerRowByVisiblePreview(preview: string) {
  const list = await screen.findByTestId("manager-list");
  fireEvent.click((await within(list).findByText(preview)).closest("button")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [email("email-b", "property-b", "K")];
  state.sms = [sms("K", ["property-a"], "A native history"), sms("K-conflict", ["property-a", "property-b"], "A and B native history")];
  state.archivedSms = new Set();
  state.replyChannels = { viaProplane: true, viaEmail: false, viaSms: false };
  state.sendPropLane.mockResolvedValue({ ok: true });
  state.post.mockImplementation(async (sources: Array<{ id: string }>) => sources.map((source) => ({ id: source.id, status: "read", unread: false })));
});

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("ManagerUnifiedInbox relationship selection", () => {
  it("keeps incompatible property-A native history out of a selected property-B row and does not acknowledge it", async () => {
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const row = (await screen.findByText("email-b email")).closest("button");
    fireEvent.click(row!);
    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-b email")).toBeTruthy();
    expect(within(thread).queryByText("A native history")).toBeNull();
    expect(within(thread).queryByText("A and B native history")).toBeNull();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(state.post.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ id: "email-b", observation: "obs-email-b" })]);
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-a") ?? "[]")).not.toContain("message-K");
  });

  it("keeps native history out when stored email provenance conflicts with its scalar binding", async () => {
    state.rows = [{
      ...email("email-conflicted", "property-b", "K"),
      identityProvenance: [
        { managerUserId: "manager-a", propertyId: "property-a", counterpartyRole: "applicant", smsConversationKey: "K" },
        { managerUserId: "manager-a", propertyId: "property-b", counterpartyRole: "applicant", smsConversationKey: "K" },
      ],
    }];
    state.sms = [sms("K", ["property-b"], "Native history must stay separate")];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await screen.findByText("email-conflicted email")).closest("button")!);

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-conflicted email")).toBeTruthy();
    expect(within(thread).queryByText("Native history must stay separate")).toBeNull();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-a") ?? "[]"))
      .not.toContain("message-K");
  });

  it.each([
    ["missing", []],
    ["multiple distinct", ["property-a", "property-b"]],
    ["multiple duplicate", ["property-a", "property-a"]],
  ])("keeps %s native house evidence isolated from an otherwise matching email row", async (_label, propertyIds) => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [sms("K", propertyIds, `${_label} house evidence`)];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    await clickManagerRowByVisiblePreview("email-a email");

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    expect(within(thread).queryByText(`${_label} house evidence`)).toBeNull();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-a") ?? "[]"))
      .not.toContain("message-K");
  });

  it("renders and acknowledges only compatible email and native members", async () => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [sms("K", ["property-a"], "A native history"), sms("other", ["property-b"], "B native history")];
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    // The accepted native member is newer, so the real row preview is native.
    await clickManagerRowByVisiblePreview("A native history");
    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    expect(within(thread).getByText("A native history")).toBeTruthy();
    expect(within(thread).queryByText("B native history")).toBeNull();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-a") ?? "[]")).toEqual(["message-K"]);
  });

  it("preserves a native-only conversation when no email history exists", async () => {
    state.rows = [];
    state.sms = [sms("sms-only", ["property-a"], "native-only history")];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click(await screen.findByTestId("manager-conversation-row-native-only history"));

    const nativePane = await screen.findByTestId("native-pane");
    expect(nativePane).toHaveAttribute("data-native-active-id", "sms-only");
    expect(within(nativePane).getByText("native-only history")).toBeTruthy();
  });

  it("sends a PropLane reply through the selected property-A source when newer B exists", async () => {
    state.rows = [
      { ...email("email-a", "property-a", "K"), time: "Sep 18, 09:00 AM" },
      { ...email("email-b", "property-b", "K"), time: "Sep 18, 11:00 AM" },
    ];
    state.sms = [sms("K", ["property-a"], "A native history")];
    state.replyChannels = { viaProplane: true, viaEmail: false, viaSms: false };
    global.fetch = vi.fn().mockResolvedValue(Response.json({ ok: true })) as unknown as typeof fetch;

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await screen.findByText("A native history")).closest("button")!);
    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "A PropLane reply" } });
    fireEvent.click(screen.getByTestId("manager-send"));

    await waitFor(() => expect(state.sendPropLane).toHaveBeenCalledOnce());
    expect(state.sendPropLane.mock.calls[0]?.[0]).toMatchObject({
      threadId: "email-a",
      text: "A PropLane reply",
    });
    expect(within(thread).queryByText("email-b email")).toBeNull();
  });

  it("sends an email reply through the selected property-A source when newer B exists", async () => {
    state.rows = [
      { ...email("email-a", "property-a", "K"), time: "Sep 18, 09:00 AM" },
      { ...email("email-b", "property-b", "K"), time: "Sep 18, 11:00 AM" },
    ];
    state.sms = [sms("K", ["property-a"], "A native history")];
    state.replyChannels = { viaProplane: false, viaEmail: true, viaSms: false };
    global.fetch = vi.fn().mockResolvedValue(Response.json({ ok: true })) as unknown as typeof fetch;

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.click((await screen.findByText("A native history")).closest("button")!);
    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "A email reply" } });
    fireEvent.click(screen.getByTestId("manager-send"));

    await waitFor(() => {
      const post = vi.mocked(global.fetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ threadId: "email-a", text: "A email reply" });
    });
    expect(within(thread).queryByText("email-b email")).toBeNull();
  });

  it("keeps a submitted applicant label on the verified prospect relationship and renders one timeline", async () => {
    const prospectKey = "manager-a:prospect:+12065550142";
    state.rows = [email("submitted-application", "property-a", prospectKey, "prospect")];
    state.sms = [sms(prospectKey, ["property-a"], "Earlier tour question", "prospect")];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    const list = await screen.findByTestId("manager-list");
    // The newer SMS member supplies the row preview.
    fireEvent.click((await within(list).findByText("Earlier tour question")).closest("button")!);

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("submitted-application email")).toBeTruthy();
    expect(within(thread).getByText("Earlier tour question")).toBeTruthy();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(JSON.parse(window.localStorage.getItem("axis_manager_sms_opened_v2:manager-a") ?? "[]"))
      .toEqual([`message-${prospectKey}`]);
  });

  it.each([
    ["lease-packet", "lease-packet email", "native history without the search term"],
    ["inspection-window", "email history without the search term", "inspection-window native"],
  ])("keeps the complete compatible timeline when search matches the %s channel", async (term, emailBody, smsBody) => {
    state.rows = [{ ...email("email-a", "property-a", "K"), body: emailBody, preview: emailBody }];
    state.sms = [sms("K", ["property-a"], smsBody)];

    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);
    fireEvent.change(await screen.findByPlaceholderText("Search contacts or messages"), { target: { value: term } });
    await clickManagerRowByVisiblePreview(smsBody);

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText(emailBody)).toBeTruthy();
    expect(within(thread).getByText(smsBody)).toBeTruthy();
  });

  it("keeps a selected compatible timeline mounted after the only unread channel is acknowledged", async () => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [sms("K", ["property-a"], "already-read native history")];
    window.localStorage.setItem("axis_manager_sms_opened_v2:manager-a", JSON.stringify(["message-K"]));

    render(<ManagerUnifiedInbox tabId="unopened" listSegment="unread" commBase="/portal/communication" smsUiEnabled />);
    await clickManagerRowByVisiblePreview("already-read native history");

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    expect(within(thread).getByText("already-read native history")).toBeTruthy();
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    expect(screen.getByTestId("thread")).toBeTruthy();
    expect(within(screen.getByTestId("thread")).getByText("already-read native history")).toBeTruthy();
  });

  it("keeps Active and Archived relationship rows separate", async () => {
    state.rows = [email("email-active", "property-a", "K"), { ...email("email-archived", "property-a", "K"), folder: "trash" }];
    state.sms = [sms("K", ["property-a"], "active native history")];

    const view = render(<ManagerUnifiedInbox tabId="unopened" listSegment="active" commBase="/portal/communication" smsUiEnabled />);
    expect(await screen.findByText("active native history")).toBeTruthy();
    expect(screen.queryByText("email-archived email")).toBeNull();

    view.rerender(<ManagerUnifiedInbox tabId="unopened" listSegment="archived" commBase="/portal/communication" smsUiEnabled />);
    expect(await screen.findByText("email-archived email")).toBeTruthy();
    expect(screen.queryByText("active native history")).toBeNull();
  });

  it("clears a resolved routed row when search excludes it", async () => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [];
    const routeChanges: Array<string | undefined> = [];
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    expect(await screen.findByText("email-a email")).toBeTruthy();
    fireEvent.change(await screen.findByPlaceholderText("Search contacts or messages"), { target: { value: "no such conversation" } });
    await waitFor(() => expect(routeChanges).toContain(undefined));
    expect(screen.queryByText("email-a email")).toBeNull();
  });

  it("clears a resolved routed row when its status partition changes", async () => {
    state.rows = [{
      ...email("email-a", "property-a", "K"),
      unread: false,
      readSources: [{ id: "email-a", observation: "obs-email-a", unread: false }],
    }];
    state.sms = [];
    // Start from confirmed read state and switch to Unread. An unresolved read
    // request cannot hold a row unread because opening applies that state
    // optimistically before persistence settles.
    const routeChanges: Array<string | undefined> = [];
    const view = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        listSegment="active"
        routeThreadId="email-a"
        threadFilters={{ status: "read" }}
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    expect(await within(await screen.findByTestId("thread")).findByText("email-a email")).toBeTruthy();
    view.rerender(
      <ManagerUnifiedInbox
        tabId="unopened"
        listSegment="active"
        routeThreadId="email-a"
        threadFilters={{ status: "unread" }}
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    await waitFor(() => expect(routeChanges).toContain(undefined));
    expect(screen.queryByText("email-a email")).toBeNull();
  });

  it("clears a resolved routed row when it moves to the archive folder", async () => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [];
    const routeChanges: Array<string | undefined> = [];
    const view = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        listSegment="active"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    expect(await screen.findByText("email-a email")).toBeTruthy();
    state.rows = [{ ...email("email-a", "property-a", "K"), folder: "trash" }];
    fireEvent(window, new CustomEvent("axis-portal-inbox-changed"));
    view.rerender(
      <ManagerUnifiedInbox
        tabId="unopened"
        listSegment="active"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    await waitFor(() => expect(routeChanges).toContain(undefined));
    expect(screen.queryByText("email-a email")).toBeNull();
  });

  it("resolves a deep link to an accepted non-winning member", async () => {
    state.rows = [{ ...email("email-a", "property-a", "K"), time: "Sep 18, 09:00 AM" }];
    state.sms = [sms("K", ["property-a"], "newer native turn")];
    const routeChanges: Array<string | undefined> = [];

    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    expect(within(thread).getByText("newer native turn")).toBeTruthy();
    expect(routeChanges).not.toContain(undefined);
    const row = within(await screen.findByTestId("manager-list")).getByText("newer native turn").closest("button");
    await waitFor(() => expect(row).toHaveAttribute("aria-pressed", "true"));
  });

  it("keeps a resolved route when a new accepted member becomes the winner", async () => {
    state.rows = [{ ...email("email-a", "property-a", "K"), time: "Sep 18, 10:00 AM" }];
    state.sms = [];
    const routeChanges: Array<string | undefined> = [];
    const view = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );

    const initialThread = await screen.findByTestId("thread");
    expect(within(initialThread).getByText("email-a email")).toBeTruthy();
    expect(routeChanges).not.toContain(undefined);
    state.sms = [sms("K", ["property-a"], "new accepted native turn")];
    fireEvent(window, new CustomEvent("axis:manager-sms-contacts-changed"));
    view.rerender(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="email-a"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );

    const thread = await screen.findByTestId("thread");
    expect(within(thread).getByText("email-a email")).toBeTruthy();
    expect(await within(thread).findByText("new accepted native turn")).toBeTruthy();
    expect(routeChanges).not.toContain(undefined);
  });

  it("keeps an unresolved routed row pending until the matching row arrives", async () => {
    state.rows = [];
    state.sms = [];
    const routeChanges: Array<string | undefined> = [];
    const view = render(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="late-thread"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    expect(screen.queryByText("late-thread email")).toBeNull();
    expect(routeChanges).not.toContain(undefined);
    await within(screen.getByTestId("manager-list")).findByText("PropLane Assistant");
    state.rows = [email("late-thread", "property-a", "K")];
    fireEvent(window, new CustomEvent("axis-portal-inbox-changed"));
    view.rerender(
      <ManagerUnifiedInbox
        tabId="unopened"
        routeThreadId="late-thread"
        onRouteThreadChange={(id) => routeChanges.push(id)}
        commBase="/portal/communication"
        smsUiEnabled
      />,
    );
    const routedRow = (await within(screen.getByTestId("manager-list")).findByText("late-thread email")).closest("button");
    expect(routedRow).toBeTruthy();
    await waitFor(() => expect(routedRow!.getAttribute("aria-pressed")).toBe("true"));
    expect(routeChanges).not.toContain(undefined);
  });

  it("does not retain just-read selection after the search context changes", async () => {
    state.rows = [email("email-a", "property-a", "K")];
    state.sms = [sms("K", ["property-a"], "A native history")];
    render(<ManagerUnifiedInbox tabId="unopened" listSegment="unread" commBase="/portal/communication" smsUiEnabled />);
    await clickManagerRowByVisiblePreview("A native history");
    expect(await screen.findByText("email-a email")).toBeTruthy();
    fireEvent.change(await screen.findByPlaceholderText("Search contacts or messages"), { target: { value: "unmatched" } });
    await waitFor(() => expect(screen.queryByText("email-a email")).toBeNull());
  });
});
