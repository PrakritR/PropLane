// @vitest-environment jsdom
//
// The manager Communication inbox is a single, unified, conversation-based list
// — NO Unopened / Opened / Sent / Trash / Schedule folder tabs. This locks in:
//
//  1. Live conversations (inbox + sent) show together in ONE list; archived
//     (trashed) conversations are reachable via a toggle, not a tab.
//  2. SMS conversations are gated behind `smsUiEnabled`. When off (default,
//     A2P not cleared) the SMS endpoint is never fetched and no SMS row shows;
//     when on, SMS rows join the same list. Transport is unaffected either way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";

const EMAIL_INBOX = {
  id: "thr-2000000001",
  folder: "inbox",
  from: "Dana Ramirez",
  email: "dana@example.com",
  subject: "Parking spot question",
  preview: "Is there a parking spot available?",
  body: "Is there a parking spot available?",
  time: "Jul 20, 2026",
  unread: true,
};
const EMAIL_SENT = {
  id: "thr-2000000002",
  folder: "sent",
  from: "Property manager",
  email: "sam@example.com",
  subject: "Lease renewal",
  preview: "Your lease renews next month",
  body: "Your lease renews next month",
  time: "Jul 19, 2026",
  unread: false,
};
const EMAIL_TRASH = {
  id: "thr-2000000003",
  folder: "trash",
  from: "Old Flyer",
  email: "old@example.com",
  subject: "Discount inspection",
  preview: "cheap roof inspection",
  body: "cheap roof inspection",
  time: "Jul 01, 2026",
  unread: false,
};

const ALL_THREADS = [EMAIL_INBOX, EMAIL_SENT, EMAIL_TRASH];

const SMS_PAYLOAD = {
  workNumber: "+12065550999",
  residents: [
    {
      residentUserId: "res-1",
      residentEmail: "jordan@example.com",
      name: "Jordan Lee",
      phone: "+12065550142",
      propertyLabel: "Maple · 2A",
      conversationKey: "owner:resident:res-1",
      messages: [
        {
          id: "sms-1",
          direction: "inbound",
          body: "Can I swap my parking stall?",
          fromPhone: "+12065550142",
          toPhone: "+12065550999",
          messageSid: "SM1",
          source: "work_number",
          createdAt: "2026-07-20T17:00:00.000Z",
          storageTable: "inbound_sms_log",
        },
      ],
    },
  ],
};

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
  loadPersistedInbox: () => ALL_THREADS,
  syncPersistedInboxFromServer: () => Promise.resolve(ALL_THREADS),
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
  inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
    { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
  ],
}));
vi.mock("@/components/portal/manager-inbox", () => ({
  ManagerInbox: () => <div data-testid="embedded-email-thread" />,
}));
vi.mock("@/components/portal/manager-resident-detail-inbox", () => ({
  ResidentDirectChatPane: ({ onSent }: { onSent: () => void }) => (
    <button type="button" data-testid="direct-chat-sent" onClick={onSent}>
      Sent
    </button>
  ),
}));
vi.mock("@/components/portal/manager-sms-panel", () => ({ ManagerSmsPanel: () => <div /> }));

import { ManagerUnifiedInbox } from "@/components/portal/manager-unified-inbox";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("unified conversation inbox (no folder tabs)", () => {
  it("shows live inbox + sent conversations in one list and archives via a toggle", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" />);

    // Inbox and sent conversations appear together — no folder segregation.
    expect(screen.getByText("Dana Ramirez")).toBeTruthy();
    expect(screen.getByText("sam@example.com")).toBeTruthy();
    // Trashed conversation is NOT in the default view.
    expect(screen.queryByText("Old Flyer")).toBeNull();

    // Archive segment — routed links in the list chrome (internal mode).
    const archivedLink = screen.getByRole("link", { name: /Archived/ });
    expect(archivedLink.getAttribute("href")).toContain("/archived");

    const unreadLink = screen.getByRole("link", { name: /Unread/ });
    expect(unreadLink.getAttribute("href")).toContain("/unread");

    cleanup();
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" listSegment="unread" />);
    expect(screen.getByText("Dana Ramirez")).toBeTruthy();
    expect(screen.queryByText("sam@example.com")).toBeNull();
    expect(screen.queryByText("Old Flyer")).toBeNull();

    cleanup();
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" listSegment="archived" />);
    expect(screen.getByText("Old Flyer")).toBeTruthy();
    expect(screen.queryByText("Dana Ramirez")).toBeNull();
  });

  it("keeps search scoped to Unread instead of leaking matching read threads", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        listSegment="unread"
        searchQuery="lease"
        onSearchQueryChange={() => {}}
      />,
    );

    expect(screen.queryByText("sam@example.com")).toBeNull();
    expect(screen.getByText(/No messages match/)).toBeTruthy();
  });

  it("never fetches SMS and shows no SMS row when the SMS UI flag is off (default)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(SMS_PAYLOAD), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" />);

    await waitFor(() => expect(screen.getByText("Dana Ramirez")).toBeTruthy());
    expect(screen.queryByText("Jordan Lee")).toBeNull();
    const calledSms = fetchMock.mock.calls.some(([url]) => String(url).includes("/api/manager/sms-conversations"));
    expect(calledSms).toBe(false);
  });

  it("does not fetch SMS when a direct placeholder send refreshes with the UI hidden", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        filterContacts={[
          {
            id: "new-resident",
            name: "New Resident",
            email: "new-resident@example.com",
            role: "resident",
            propertyId: "property-1",
            propertyLabel: "Maple House",
          },
        ]}
      />,
    );

    fireEvent.click(await screen.findByText("New Resident"));
    fireEvent.click(await screen.findByTestId("direct-chat-sent"));

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/manager/sms-conversations",
      expect.anything(),
    ));
  });

  it("shows SMS conversations alongside email when the SMS UI flag is on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SMS_PAYLOAD), { status: 200 })));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await waitFor(() => expect(screen.getByText("Jordan Lee")).toBeTruthy());
    expect(screen.getByText("Dana Ramirez")).toBeTruthy();
  });

  it("shows a saved phone contact before the first message exists", async () => {
    const contactPayload = {
      ...SMS_PAYLOAD,
      residents: [
        {
          residentUserId: null,
          residentEmail: null,
          name: "Jordan Contact",
          savedContactName: "Jordan Contact",
          phone: "+12065550123",
          propertyLabel: null,
          counterpartyRole: "unknown",
          conversationKey: "owner:unknown:+12065550123",
          messages: [],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(contactPayload), { status: 200 })));
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" smsUiEnabled />);

    await waitFor(() => expect(screen.getByText("Jordan Contact")).toBeTruthy());
    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("opens a just-created contact from an optimistic seed before SMS refetch", async () => {
    // Refetch stays empty forever — the only way the thread appears is the
    // optimistic CustomEvent payload from contact create.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ workNumber: "+12065550999", residents: [] }), { status: 200 })),
    );
    const { MANAGER_SMS_CONTACTS_CHANGED_EVENT } = await import("@/lib/manager-sms-messages");
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        smsUiEnabled
        routeThreadId="owner:unknown:+12065550987"
      />,
    );

    window.dispatchEvent(
      new CustomEvent(MANAGER_SMS_CONTACTS_CHANGED_EVENT, {
        detail: {
          optimisticResident: {
            residentUserId: null,
            residentEmail: null,
            name: "Fresh Contact",
            directoryName: null,
            savedContactName: "Fresh Contact",
            phone: "+12065550987",
            propertyLabel: null,
            counterpartyRole: "unknown",
            conversationKey: "owner:unknown:+12065550987",
            memberKeys: ["owner:unknown:+12065550987"],
            messages: [],
          },
        },
      }),
    );

    await waitFor(() => expect(screen.getByText("Fresh Contact")).toBeTruthy());
    // Selection must prefer the routed SMS contact over the first email row.
    expect(screen.queryByTestId("embedded-email-thread")).toBeNull();
  });

  it("shows archived SMS conversations in the archived segment", async () => {
    window.localStorage.setItem(
      "axis_manager_sms_archived_v1",
      JSON.stringify(["owner:resident:res-1"]),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SMS_PAYLOAD), { status: 200 })));
    render(
      <ManagerUnifiedInbox
        tabId="unopened"
        commBase="/portal/communication"
        listSegment="archived"
        smsUiEnabled
      />,
    );

    await waitFor(() => expect(screen.getByText("Jordan Lee")).toBeTruthy());
    expect(screen.queryByText("Dana Ramirez")).toBeNull();
    window.localStorage.removeItem("axis_manager_sms_archived_v1");
  });

  it("does not open a thread on mobile when re-tapping the Active segment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })),
    );
    render(<ManagerUnifiedInbox tabId="unopened" commBase="/portal/communication" />);
    await waitFor(() => expect(screen.getByText("Dana Ramirez")).toBeTruthy());
    expect(screen.queryByTestId("embedded-email-thread")).toBeNull();

    const activeLink = screen.getByRole("link", { name: /^Active/ });
    expect(activeLink.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("embedded-email-thread")).toBeNull();
  });
});
