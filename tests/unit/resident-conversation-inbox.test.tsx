// @vitest-environment jsdom
//
// Resident Communication matches the manager CRM layout: Active / Unread / Archived
// segments, unified conversation list, and Archive (not Trash).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const session = vi.hoisted(() => ({ userId: "resident-test" }));

const EMAIL_INBOX = {
  id: "res-thr-1000000001",
  folder: "inbox",
  from: "Property manager",
  email: "manager@example.com",
  subject: "Welcome to your unit",
  preview: "Here is your move-in info",
  body: "Here is your move-in info",
  time: "Jul 20, 2026",
  unread: true,
};
const EMAIL_ARCHIVED = {
  id: "res-thr-1000000002",
  folder: "trash",
  from: "Old notice",
  email: "old@example.com",
  subject: "Old",
  preview: "old",
  body: "old",
  time: "Jul 01, 2026",
  unread: false,
};

let serverEmailRows = [EMAIL_INBOX, EMAIL_ARCHIVED];

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/communication/active",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));

vi.mock("@/lib/portal-inbox-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-inbox-storage")>(
    "@/lib/portal-inbox-storage",
  );
  return {
    ...actual,
    inboxThreadSortMs: actual.inboxThreadSortMs,
    // The real local store receives the same rows as the latest server sync.
    // Keep the fixture coherent when staging emits an inbox-changed event.
    loadPersistedInbox: () => serverEmailRows,
    syncPersistedInboxFromServerWithStatus: async () => {
      const response = await fetch("/api/portal-inbox-threads?scope=resident-inbox");
      const body = (await response.json().catch(() => null)) as { rows?: typeof serverEmailRows } | null;
      return { rows: body?.rows ?? serverEmailRows, ok: response.ok };
    },
    inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
      { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
    ],
  };
});
vi.mock("@/components/portal/resident-inbox-panel", () => ({
  ResidentInboxPanel: ({
    controlledExpandedId,
    communicationSmsMessages = [],
    communicationThreadTitle,
  }: {
    controlledExpandedId?: string | null;
    communicationSmsMessages?: Array<{ id: string; body: string; direction: string }>;
    communicationThreadTitle?: string;
  }) => (
    <div data-testid="resident-thread" data-expanded-id={controlledExpandedId ?? ""}>
      {controlledExpandedId ? <span>{communicationThreadTitle}</span> : null}
      {controlledExpandedId ? <span data-channel="email">Email: Here is your move-in info</span> : null}
      {communicationSmsMessages.map((message) => (
        <span key={message.id} data-channel="sms">SMS: {message.body}</span>
      ))}
    </div>
  ),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: session.userId, email: `${session.userId}@example.com`, ready: true }),
}));
vi.mock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div data-testid="role-sms" /> }));

import { ResidentCommunication } from "@/components/portal/resident-communication";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.userId = "resident-test";
  serverEmailRows = [EMAIL_INBOX, EMAIL_ARCHIVED];
});

describe("resident conversation inbox", () => {
    it("offers Filter instead of folder rails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication />);

    expect(screen.getByRole("button", { name: "Filter", exact: true })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Unread/i })).toBeNull();
    await waitFor(() => expect(screen.getByText("Property manager")).toBeTruthy());
    expect(screen.queryByText("Old notice")).toBeNull();
  });

  it("lists archived conversations on the Archived segment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication listSegment="archived" />);
    await waitFor(() => expect(screen.getByText("Old notice")).toBeTruthy());
    expect(screen.queryByText("Property manager")).toBeNull();
  });

  it("does not offer Set up messaging on resident Communication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResidentCommunication />);
    expect(screen.queryByRole("button", { name: /set up messaging/i })).toBeNull();
    expect(screen.queryByText("Set up messaging")).toBeNull();
    expect(screen.getByRole("button", { name: /new message/i })).toBeTruthy();
  });

  it("does not fetch SMS when the SMS UI flag is off (default)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("Property manager")).toBeTruthy());
    const calledSms = fetchMock.mock.calls.some(([url]) => String(url).includes("/api/resident/sms-conversations"));
    expect(calledSms).toBe(false);
  });

  it("merges a verified property-manager SMS conversation into the named historical email row and opens the full thread", async () => {
    const historicalPropertyManager = {
      id: "property_mgr_9j7pef",
      folder: "inbox",
      from: "Morgan Manager",
      email: "manager@example.com",
      managerUserId: "manager-1",
      propertyId: "mgr-scale-06",
      subject: "Tour request",
      preview: "Your tour request is received",
      body: "Your tour request is received",
      time: "Sep 18, 2026, 9:00 AM",
      unread: false,
      sourceThreadIds: ["property_mgr_9j7pef"],
    };
    const ordinaryManagerEmail = {
      ...EMAIL_INBOX,
      id: "manager-email-1",
      from: "Property manager",
      email: "manager@example.com",
      managerUserId: "manager-1",
      propertyId: "mgr-scale-06",
      body: "Here is your move-in info",
      preview: "Here is your move-in info",
    };
    serverEmailRows = [historicalPropertyManager, ordinaryManagerEmail];
    const sms = {
      conversationKey: "manager-1:resident:res-1",
      managerUserId: "manager-1",
      managerName: "Morgan Manager",
      managerEmail: "manager@example.com",
      counterpartyRole: "resident",
      propertyId: "mgr-scale-06",
      propertyTitle: "Ash Flats 6",
      messages: [{
        id: "sms-manager-1",
        direction: "inbound",
        body: "Your tour is confirmed",
        fromPhone: "+12065550142",
        toPhone: "+12065550999",
        messageSid: "SM1",
        source: "work_number",
        createdAt: "2026-09-18T16:05:00.000Z",
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      if (url.includes("/api/resident/sms-conversations")) {
        return new Response(JSON.stringify({ messages: [], conversations: [sms] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ResidentCommunication smsUiEnabled threadId="property_mgr_9j7pef" />);

    await waitFor(() => expect(screen.getAllByText("Morgan Manager").length).toBeGreaterThan(0));
    expect(screen.getByText("PropLane Assistant")).toBeTruthy();
    expect(screen.getByText("Your tour is confirmed")).toBeTruthy();
    expect(screen.getByText("SMS: Your tour is confirmed")).toBeTruthy();
    expect(screen.getByText("Email: Here is your move-in info")).toBeTruthy();
    expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "property_mgr_9j7pef");
    expect(screen.getByText("SMS: Your tour is confirmed")).toHaveAttribute("data-channel", "sms");
    expect(screen.getByText("Email: Here is your move-in info")).toHaveAttribute("data-channel", "email");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/portal-inbox-threads"))).toBe(true);
  });

  it("keeps two managers and an unknown SMS identity as separate rows", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "manager-a-email",
      from: "Manager A",
      email: "manager-a@example.com",
      managerUserId: "manager-a",
      propertyId: "property-a",
    }];
    const conversations = [
      {
        conversationKey: "manager-a:resident:res-1",
        managerUserId: "manager-a",
        managerName: "Manager A",
        managerEmail: "manager-a@example.com",
        counterpartyRole: "resident",
        propertyId: "property-a",
        messages: [{ id: "sms-a", direction: "inbound", body: "MANAGER A PRIVATE", createdAt: "2026-09-18T16:00:00.000Z" }],
      },
      {
        conversationKey: "manager-b:resident:res-1",
        managerUserId: "manager-b",
        managerName: "Manager B",
        managerEmail: "manager-b@example.com",
        counterpartyRole: "resident",
        propertyId: "property-b",
        messages: [{ id: "sms-b", direction: "inbound", body: "MANAGER B PRIVATE", createdAt: "2026-09-18T16:01:00.000Z" }],
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      if (url.includes("/api/resident/sms-conversations")) return new Response(JSON.stringify({ messages: [{ id: "unknown", direction: "inbound", body: "UNKNOWN PRIVATE", createdAt: "2026-09-18T16:02:00.000Z" }], conversations }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ResidentCommunication smsUiEnabled />);

    await waitFor(() => expect(screen.getAllByText("Manager A").length).toBeGreaterThan(0));
    expect(screen.getByText("Manager B")).toBeTruthy();
    expect(screen.getByText("Text messages")).toBeTruthy();
    expect(screen.getAllByText(/conversation/).length).toBeGreaterThan(0);

    const managerBRowButton = screen.getByText("Manager B").closest("button");
    expect(managerBRowButton).toBeTruthy();
    fireEvent.click(managerBRowButton!);
    await waitFor(() => expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).toContain("MANAGER B PRIVATE"));
    expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).not.toContain("MANAGER A PRIVATE");
    expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).not.toContain("UNKNOWN PRIVATE");

    const unknownRowButton = screen.getAllByText("Text messages")
      .map((label) => label.closest("button"))
      .find((button): button is HTMLButtonElement => Boolean(button));
    expect(unknownRowButton).toBeTruthy();
    fireEvent.click(unknownRowButton!);
    await waitFor(() => expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).toContain("UNKNOWN PRIVATE"));
    expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).not.toContain("MANAGER A PRIVATE");
    expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).not.toContain("MANAGER B PRIVATE");
  });

  it("isolates an explicitly bound B conversation from an email carrying only A metadata", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "email-a-with-b-binding",
      from: "Manager A",
      email: "shared@example.com",
      managerUserId: "manager-a",
      propertyId: "property-a",
      smsConversationKey: "manager-b:resident:person-b",
      body: "A metadata must not enter B",
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      if (url.includes("/api/resident/sms-conversations")) return new Response(JSON.stringify({ messages: [], conversations: [{
        conversationKey: "manager-b:resident:person-b",
        managerUserId: "manager-b",
        managerName: "Manager B",
        managerEmail: "shared@example.com",
        counterpartyRole: "resident",
        propertyId: "property-b",
        messages: [{ id: "sms-b-bound", direction: "inbound", body: "B PRIVATE", createdAt: "2026-09-18T16:01:00.000Z" }],
      }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }));

    render(<ResidentCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    expect(screen.getByText("Manager B")).toBeTruthy();
    const managerB = screen.getByText("Manager B").closest("button");
    expect(managerB).toBeTruthy();
    fireEvent.click(managerB!);
    await waitFor(() => expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).toContain("B PRIVATE"));
    expect(document.querySelector(".portal-inbox-inbound-bubble")?.textContent).not.toContain("A metadata");
  });

  it("keeps both channel members when Unread matches only the SMS turn", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "manager-a-email-unread-filter",
      from: "Manager A",
      email: "manager-a@example.com",
      managerUserId: "manager-a",
      propertyId: "property-a",
      unread: false,
      body: "EMAIL HISTORY MUST STAY",
      preview: "EMAIL HISTORY MUST STAY",
    }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      if (url.includes("/api/resident/sms-conversations")) return new Response(JSON.stringify({
        messages: [],
        conversations: [{
          conversationKey: "manager-a:resident:res-1",
          managerUserId: "manager-a",
          managerName: "Manager A",
          managerEmail: "manager-a@example.com",
          counterpartyRole: "resident",
          propertyId: "property-a",
          messages: [{ id: "sms-unread", direction: "inbound", body: "SMS ONLY MATCH", createdAt: "2026-09-18T16:01:00.000Z" }],
        }],
      }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ResidentCommunication smsUiEnabled listSegment="unread" />);
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    const row = screen.getByText("Manager A").closest("button");
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    await waitFor(() => expect(screen.getByText("Email: Here is your move-in info")).toBeTruthy());
    expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "manager-a-email-unread-filter");
  });

  it("keeps the full safe member set when search matches only the SMS body", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "manager-a-email-search",
      from: "Manager A",
      email: "manager-a@example.com",
      managerUserId: "manager-a",
      propertyId: "property-a",
      body: "EMAIL HISTORY MUST STAY",
      preview: "EMAIL HISTORY MUST STAY",
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      if (url.includes("/api/resident/sms-conversations")) return new Response(JSON.stringify({ messages: [], conversations: [{
        conversationKey: "manager-a:resident:res-1",
        managerUserId: "manager-a",
        managerName: "Manager A",
        managerEmail: "manager-a@example.com",
        counterpartyRole: "resident",
        propertyId: "property-a",
        messages: [{ id: "sms-search", direction: "inbound", body: "SEARCH ONLY SMS", createdAt: "2026-09-18T16:01:00.000Z" }],
      }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }));

    render(<ResidentCommunication smsUiEnabled />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "search only sms" } });
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    const row = screen.getByText("Manager A").closest("button");
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    await waitFor(() => expect(screen.getByText("Email: Here is your move-in info")).toBeTruthy());
    expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "manager-a-email-search");
  });

  it("keeps same-email property histories separate when SMS is off and no native history exists", async () => {
    serverEmailRows = [
      {
        ...EMAIL_INBOX,
        id: "same-email-property-a",
        from: "Manager A",
        email: "shared-manager@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
        body: "PROPERTY A HISTORY",
        preview: "PROPERTY A HISTORY",
      },
      {
        ...EMAIL_INBOX,
        id: "same-email-property-b",
        from: "Manager B",
        email: "shared-manager@example.com",
        managerUserId: "manager-b",
        propertyId: "property-b",
        body: "PROPERTY B HISTORY",
        preview: "PROPERTY B HISTORY",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    render(<ResidentCommunication smsUiEnabled={false} />);
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    expect(screen.getByText("Manager B")).toBeTruthy();
    const managerB = screen.getByText("Manager B").closest("button");
    expect(managerB).toBeTruthy();
    fireEvent.click(managerB!);
    expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "same-email-property-b");
  });

  it("merges compatible same-property email histories while keeping the full source membership", async () => {
    serverEmailRows = [
      {
        ...EMAIL_INBOX,
        id: "compatible-history-a",
        from: "Manager A",
        email: "shared-manager@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
        body: "FIRST HISTORY",
        preview: "FIRST HISTORY",
        sourceThreadIds: ["compatible-history-a"],
      },
      {
        ...EMAIL_INBOX,
        id: "compatible-history-b",
        from: "Manager A",
        email: "shared-manager@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
        body: "SECOND HISTORY",
        preview: "SECOND HISTORY",
        sourceThreadIds: ["compatible-history-b"],
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    render(<ResidentCommunication smsUiEnabled={false} />);
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    expect(screen.getAllByText("Manager A")).toHaveLength(1);
    fireEvent.click(screen.getByText("Manager A").closest("button")!);
    // The selected canonical row remains addressable through either source id.
    expect(screen.getByTestId("resident-thread").getAttribute("data-expanded-id")).toMatch(
      /compatible-history-(a|b)/,
    );
  });

  it("does not let conflicting or unknown same-email rows bridge into one conversation", async () => {
    serverEmailRows = [
      {
        ...EMAIL_INBOX,
        id: "conflict-property-a",
        from: "Manager A",
        email: "shared-manager@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
      },
      {
        ...EMAIL_INBOX,
        id: "conflict-property-b",
        from: "Manager B",
        email: "shared-manager@example.com",
        managerUserId: "manager-b",
        propertyId: "property-b",
      },
      {
        ...EMAIL_INBOX,
        id: "unknown-property",
        from: "Unknown manager",
        email: "shared-manager@example.com",
        managerUserId: "",
        propertyId: "",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    render(<ResidentCommunication smsUiEnabled={false} />);
    await waitFor(() => expect(screen.getByText("Manager A")).toBeTruthy());
    expect(screen.getByText("Manager B")).toBeTruthy();
    expect(screen.getByText("Unknown manager")).toBeTruthy();
  });

  it("releases a failed read acknowledgement, retries on reopen, and dedupes later success", async () => {
    const readRow = {
      ...EMAIL_INBOX,
      id: "read-retry-row",
      readSourcesComplete: true,
      readSources: [{ id: "read-source-1", observation: "obs-1", unread: true }],
    };
    serverEmailRows = [readRow];
    let markReadCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/portal-inbox-threads") && init?.method === "POST") {
        markReadCalls += 1;
        if (markReadCalls === 1) throw new Error("temporary network failure");
        return new Response(JSON.stringify({ results: [{ id: "read-source-1", status: "read", unread: false }] }), { status: 200 });
      }
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ResidentCommunication smsUiEnabled={false} threadId="read-retry-row" />);
    await waitFor(() => expect(markReadCalls).toBe(1));
    await Promise.resolve();
    view.rerender(<ResidentCommunication smsUiEnabled={false} listSegment="archived" threadId="read-retry-row" />);
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
    view.rerender(<ResidentCommunication smsUiEnabled={false} threadId="read-retry-row" />);
    await waitFor(() => expect(screen.getByText("Property manager").closest("button")).toBeTruthy());
    fireEvent.click(screen.getByText("Property manager").closest("button")!);
    await waitFor(() => expect(markReadCalls).toBe(2));
    view.rerender(<ResidentCommunication smsUiEnabled={false} listSegment="archived" threadId="read-retry-row" />);
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
    view.rerender(<ResidentCommunication smsUiEnabled={false} threadId="read-retry-row" />);
    await waitFor(() => expect(screen.getByText("Property manager").closest("button")).toBeTruthy());
    fireEvent.click(screen.getByText("Property manager").closest("button")!);
    await Promise.resolve();
    expect(markReadCalls).toBe(2);
  });

  it("does not apply a delayed read result after the resident viewer changes", async () => {
    const readRow = {
      ...EMAIL_INBOX,
      id: "stale-read-row",
      readSourcesComplete: true,
      readSources: [{ id: "stale-source-1", observation: "obs-stale", unread: true }],
    };
    serverEmailRows = [readRow];
    let resolveRead!: (response: Response) => void;
    const delayedRead = new Promise<Response>((resolve) => { resolveRead = resolve; });
    let markReadCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/portal-inbox-threads") && init?.method === "POST") {
        markReadCalls += 1;
        return delayedRead;
      }
      if (String(input).includes("/api/portal-inbox-threads")) {
        const rows = session.userId === "resident-test" ? serverEmailRows : [{ ...readRow, readSources: [], readSourcesComplete: false }];
        return new Response(JSON.stringify({ rows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ResidentCommunication smsUiEnabled={false} threadId="stale-read-row" />);
    await waitFor(() => expect(markReadCalls).toBe(1));
    session.userId = "resident-switched";
    view.rerender(<ResidentCommunication smsUiEnabled={false} threadId="stale-read-row" />);
    resolveRead(new Response(JSON.stringify({ results: [{ id: "stale-source-1", status: "read", unread: false }] }), { status: 200 }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length).toBe(2));
    expect(markReadCalls).toBe(1);
  });

  it("bounds repeated failed acknowledgement attempts", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "bounded-read-row",
      readSourcesComplete: true,
      readSources: [{ id: "bounded-source-1", observation: "obs-bounded", unread: true }],
    }];
    let markReadCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/portal-inbox-threads") && init?.method === "POST") {
        markReadCalls += 1;
        throw new Error("still offline");
      }
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ResidentCommunication smsUiEnabled={false} threadId="bounded-read-row" />);
    await waitFor(() => expect(markReadCalls).toBe(1));
    await Promise.resolve();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      view.rerender(<ResidentCommunication smsUiEnabled={false} listSegment="archived" threadId="bounded-read-row" />);
      await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
      view.rerender(<ResidentCommunication smsUiEnabled={false} threadId="bounded-read-row" />);
      await waitFor(() => expect(screen.getByText("Property manager").closest("button")).toBeTruthy());
      fireEvent.click(screen.getByText("Property manager").closest("button")!);
      await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "bounded-read-row"));
    }
    await Promise.resolve();
    expect(markReadCalls).toBe(2);
  });

  it("retains an actually unread selected conversation after ACK only in the same Unread presentation", async () => {
    const unreadRow = {
      ...EMAIL_INBOX,
      id: "unread-retention-a",
      sourceThreadIds: ["unread-retention-a", "unread-retention-b"],
      readSourcesComplete: true,
      readSources: [{ id: "unread-retention-a", observation: "obs-retention", unread: true }],
    };
    serverEmailRows = [unreadRow];
    let markReadCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/portal-inbox-threads") && init?.method === "POST") {
        markReadCalls += 1;
        serverEmailRows = [{ ...unreadRow, id: "unread-retention-b", unread: false, sourceThreadIds: ["unread-retention-b", "unread-retention-a"], readSources: [{ id: "unread-retention-a", observation: "obs-retention-2", unread: false }] }];
        return new Response(JSON.stringify({ results: [{ id: "unread-retention-a", status: "read", unread: false }] }), { status: 200 });
      }
      if (String(input).includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ResidentCommunication smsUiEnabled={false} listSegment="unread" threadId="unread-retention-a" />);
    await waitFor(() => expect(markReadCalls).toBe(1));
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "unread-retention-b"));

    view.rerender(<ResidentCommunication smsUiEnabled={false} listSegment="archived" threadId="unread-retention-a" />);
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
  });

  it("clears an already-read routed conversation when the resident explicitly switches to Unread", async () => {
    serverEmailRows = [{
      ...EMAIL_INBOX,
      id: "read-to-unread-row",
      unread: false,
      readSourcesComplete: true,
      readSources: [{ id: "read-to-unread-row", observation: "obs-read", unread: false }],
    }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/portal-inbox-threads")) {
        return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }));

    const view = render(
      <ResidentCommunication smsUiEnabled={false} listSegment="active" threadId="read-to-unread-row" />,
    );
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "read-to-unread-row"));

    view.rerender(
      <ResidentCommunication smsUiEnabled={false} listSegment="unread" threadId="read-to-unread-row" />,
    );
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
  });

  it("clears an already-resolved unread route when search or viewer presentation changes", async () => {
    const row = {
      ...EMAIL_INBOX,
      id: "presentation-change-row",
      readSourcesComplete: true,
      readSources: [{ id: "presentation-change-row", observation: "obs-presentation", unread: true }],
    };
    serverEmailRows = [row];
    let markReadCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/portal-inbox-threads") && init?.method === "POST") {
        markReadCalls += 1;
        serverEmailRows = [{ ...row, unread: false, readSources: [{ id: "presentation-change-row", observation: "obs-presentation-2", unread: false }] }];
        return new Response(JSON.stringify({ results: [{ id: "presentation-change-row", status: "read", unread: false }] }), { status: 200 });
      }
      if (String(input).includes("/api/portal-inbox-threads")) return new Response(JSON.stringify({ rows: serverEmailRows }), { status: 200 });
      return new Response("{}", { status: 200 });
    }));

    const view = render(<ResidentCommunication smsUiEnabled={false} listSegment="unread" threadId="presentation-change-row" />);
    await waitFor(() => expect(markReadCalls).toBe(1));
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", "presentation-change-row"));

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "does not match" } });
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));

    view.rerender(<ResidentCommunication smsUiEnabled={false} listSegment="unread" threadId="presentation-change-row" residentUserId="different-resident" />);
    await waitFor(() => expect(screen.getByTestId("resident-thread")).toHaveAttribute("data-expanded-id", ""));
  });
});
