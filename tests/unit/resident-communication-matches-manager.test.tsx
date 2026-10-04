// @vitest-environment jsdom
//
// C1-R3 (captain 2026-10-03): resident Communication has the manager page's
// structure — Active | Archived tabs with counts, search, Filter, a round
// compose button — names the MANAGER on every row, shows the resident's OWN
// identity in the list header, and has no PropLane assistant anywhere.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const ROWS = [
  {
    id: "res-thr-1",
    folder: "inbox",
    from: "Test Everything",
    email: "assist-cascade@proplane.ai",
    subject: "Maintenance",
    preview: "Set door code for room 4",
    body: "Set door code for room 4",
    time: "Sep 28, 2026",
    unread: true,
  },
  {
    id: "res-thr-2",
    folder: "inbox",
    from: "Marta Ruiz",
    email: "assist-pioneer@proplane.ai",
    subject: "Lease",
    preview: "Your lease is ready",
    body: "Your lease is ready",
    time: "Sep 27, 2026",
    unread: false,
  },
  {
    id: "res-thr-3",
    folder: "trash",
    from: "Old notice",
    email: "old@example.com",
    subject: "Old",
    preview: "old",
    body: "old",
    time: "Jul 01, 2026",
    unread: false,
  },
  // A leftover assistant thread from before it was removed: it must never show.
  {
    id: "resident-agent-resident-test",
    folder: "inbox",
    from: "PropLane Assistant",
    email: "",
    subject: "Ask PropLane",
    preview: "Hi — you can ask me about your lease",
    body: "Hi — you can ask me about your lease",
    time: "Oct 3, 2026",
    unread: true,
  },
];

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
  ResidentInboxPanel: () => <div data-testid="resident-thread" />,
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "resident-test", email: "mia@example.com", ready: true }),
}));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({
  useResidentManagerContacts: () => [
    {
      managerName: "Cascade Lofts Management",
      phone: "+15103098345",
      phoneKind: "work",
      email: "assist-cascade@proplane.ai",
      emailKind: "work",
      propertyLabel: "Cascade Lofts",
      leaseStart: null,
      leaseEnd: null,
      status: "current",
    },
    {
      managerName: "Pioneer Properties",
      phone: null,
      phoneKind: null,
      email: "assist-pioneer@proplane.ai",
      emailKind: "work",
      propertyLabel: "The Pioneer",
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resident Communication list matches the manager page", () => {
  it("has Active | Archived tabs with counts", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("Cascade Lofts Management")).toBeTruthy());
    const active = screen.getByRole("link", { name: /^Active/ });
    const archived = screen.getByRole("link", { name: /^Archived/ });
    expect(active.textContent).toMatch(/2/);
    expect(archived.textContent).toMatch(/1/);
  });

  it("switches to the Archived tab without leaving the page", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("Cascade Lofts Management")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: /^Archived/ }));
    await waitFor(() => expect(screen.getByText("Old notice")).toBeTruthy());
    expect(screen.queryByText("Cascade Lofts Management")).toBeNull();
  });

  it("has search, Filter and a round New message action", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    expect(screen.getByLabelText("Search messages")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter", exact: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /new message/i })).toBeTruthy();
  });

  it("never shows a PropLane Assistant row, even with a leftover assistant thread", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    await waitFor(() => expect(screen.getByText("Cascade Lofts Management")).toBeTruthy());
    expect(screen.queryByText(/PropLane Assistant/i)).toBeNull();
    expect(screen.queryByText(/Ask PropLane/i)).toBeNull();
  });

  it("names each conversation's own manager and home", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    const cascade = await screen.findByText("Cascade Lofts Management");
    const pioneer = await screen.findByText("Pioneer Properties");
    const cascadeRow = cascade.closest("[data-communication-inbox-list] > *") as HTMLElement;
    const pioneerRow = pioneer.closest("[data-communication-inbox-list] > *") as HTMLElement;
    expect(within(cascadeRow).getByText("Cascade Lofts")).toBeTruthy();
    expect(within(pioneerRow).getByText("The Pioneer")).toBeTruthy();
    expect(within(pioneerRow).queryByText("Cascade Lofts")).toBeNull();
  });

  it("heads the list with the resident's own identity, not a manager's address", async () => {
    stubFetch();
    render(<ResidentCommunication />);
    const header = await screen.findByText("Mia Resident");
    const card = header.closest('[data-attr="resident-communication-identity"]') as HTMLElement;
    expect(within(card).getByText("mia@example.com")).toBeTruthy();
    expect(card.textContent).not.toMatch(/assist-/);
  });
});
