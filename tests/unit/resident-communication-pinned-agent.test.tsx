// @vitest-environment jsdom
//
// Captain, Nov 12: the resident's Communication list pins the PropLane agent first, names every other conversation
// by its HOUSE (never a phone number), opens the SAME conversation the top bar types into, and lets the resident
// start a conversation about a house they live in.
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const ROWS = [
  {
    id: "res-thr-1",
    folder: "inbox",
    from: "Cascade Lofts Management",
    email: "work@cascade.example",
    subject: "Maintenance",
    preview: "Set door code for room 4",
    body: "Set door code for room 4",
    time: "Nov 11, 2026",
    unread: true,
  },
  {
    id: "res-thr-2",
    folder: "inbox",
    from: "Marta Ruiz",
    email: "work@pioneer.example",
    subject: "Lease",
    preview: "Your lease is ready",
    body: "Your lease is ready",
    time: "Nov 12, 2026",
    unread: false,
  },
  {
    // A text from another person to the resident's OWN PropLane Number: filed under the texter's phone.
    id: "resident-agent-inbound-sms:+12065550123",
    folder: "inbox",
    from: "+12065550123",
    email: "+12065550123@sms.proplane.local",
    subject: "Text message",
    preview: "Is the room still open?",
    body: "Is the room still open?",
    time: "Nov 9, 2026",
    unread: false,
  },
];

const openCompose = vi.fn();
const hydrateArchive = vi.fn(async () => {});
let conversation: null | { messages: Array<{ role: "user" | "assistant"; content: string }>; hydrateArchive: () => Promise<void> } = null;

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/communication/active",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/lib/portal-inbox-storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-inbox-storage")>("@/lib/portal-inbox-storage");
  return {
    ...actual,
    PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
    RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
    loadPersistedInbox: () => ROWS,
    stagePersistedInboxRows: vi.fn(),
    syncPersistedInboxFromServerWithStatus: () => Promise.resolve({ rows: ROWS, ok: true }),
    inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
      { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
    ],
  };
});
vi.mock("@/components/portal/resident-inbox-panel", () => ({
  ResidentInboxPanel: forwardRef(function Panel(_props: unknown, ref: React.Ref<{ openCompose: typeof openCompose }>) {
    useImperativeHandle(ref, () => ({ openCompose }));
    return <div data-testid="resident-thread" />;
  }),
}));
vi.mock("@/components/portal/resident-assistant-thread", () => ({
  ResidentAssistantThread: () => <div data-testid="shared-assistant-thread" />,
}));
vi.mock("@/lib/axis-assistant/assistant-conversation-context", () => ({
  useAssistantConversationIfMounted: () => conversation,
  useOptionalAssistantConversation: () => conversation,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "resident-test", email: "mia@example.com", ready: true }),
}));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({
  useResidentManagerContacts: () => [
    {
      managerName: "Cascade Lofts Management",
      phone: "+12065550100",
      phoneKind: "work",
      email: "work@cascade.example",
      emailKind: "work",
      propertyLabel: "4709A 8th Ave, Seattle",
      leaseStart: null,
      leaseEnd: null,
      status: "current",
    },
    {
      managerName: "Pioneer Properties",
      phone: null,
      phoneKind: null,
      email: "work@pioneer.example",
      emailKind: "work",
      propertyLabel: "The Pioneer",
      leaseStart: null,
      leaseEnd: null,
      status: "current",
    },
    {
      managerName: "Maple Homes",
      phone: "+12065550142",
      phoneKind: "work",
      email: "work@maple.example",
      emailKind: "work",
      propertyLabel: "12 Maple Court",
      leaseStart: null,
      leaseEnd: null,
      status: "current",
    },
  ],
}));
vi.mock("@/components/portal/role-sms-panel", () => ({ RoleSmsPanel: () => <div data-testid="role-sms" /> }));

import { ResidentCommunication } from "@/components/portal/resident-communication";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/profile")) {
        return new Response(JSON.stringify({ fullName: "Mia Resident", email: "mia@example.com" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

function rowTitles(): string[] {
  return [...document.querySelectorAll("[data-attr=inbox-messages-row]")].map(
    (button) => button.querySelector("span.font-semibold, span.font-bold")?.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  // A desktop viewport: the split opens the first conversation by default.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  openCompose.mockClear();
  hydrateArchive.mockClear();
  conversation = {
    messages: [
      { role: "user", content: "What is my rent this month?" },
      { role: "assistant", content: "Your rent of $850 is due Dec 1." },
    ],
    hydrateArchive,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resident Communication: the PropLane agent, houses, my number", () => {
  it("pins PropLane first, then names every conversation by house or by what it is", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("4709A 8th Ave")).toBeTruthy());
    const titles = rowTitles();
    expect(titles[0]).toBe("PropLane");
    expect(titles).toContain("4709A 8th Ave");
    expect(titles).toContain("The Pioneer");
    expect(titles).toContain("My PropLane agent");
    // The manager's name is the plain line under the row; a phone number is never a title.
    expect(screen.getByText("Cascade Lofts Management")).toBeTruthy();
    for (const title of titles) expect(title).not.toMatch(/\d{3}[^\p{L}]*\d{4}/u);
  });

  it("previews the pinned row from the shared assistant conversation and restores it on open", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText(/Your rent of \$850 is due Dec 1\./)).toBeTruthy());
    expect(hydrateArchive).toHaveBeenCalled();
  });

  it("opens the shared assistant conversation by default, not a stored inbox thread", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByTestId("shared-assistant-thread")).toBeTruthy());
  });

  it("shows no PropLane row where no assistant is mounted (demo, View as)", async () => {
    conversation = null;
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("4709A 8th Ave")).toBeTruthy());
    expect(rowTitles()).not.toContain("PropLane");
    expect(screen.queryByTestId("shared-assistant-thread")).toBeNull();
  });

  it("offers a house with no conversation yet, and starting it opens New message to that house's manager", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("12 Maple Court")).toBeTruthy());
    // An offer, not a conversation: the Active count is three (agent, 4709A, The Pioneer) + the number's text = 4.
    expect(screen.getByRole("link", { name: /^Active/ }).textContent).toMatch(/4/);
    const starter = screen.getByText("12 Maple Court").closest("button")!;
    expect(within(starter).getByText("No messages yet.")).toBeTruthy();
    fireEvent.click(starter);
    expect(openCompose).toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmail: "work@maple.example", subject: "Question about 12 Maple Court" }),
    );
  });
});
