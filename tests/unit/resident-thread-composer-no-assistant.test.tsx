// @vitest-environment jsdom
//
// C1-R3: the resident's reply row is the manager's minus every assistant tool.
// Attachment, the schedule clock and the channel menu are there; the ✦ AI
// draft, Ask PropLane and the Auto-send checkbox are not. The thread header
// carries the manager's name and icon actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const THREAD = {
  id: "res-thr-1000000001",
  folder: "inbox" as const,
  from: "Test Manager",
  email: "assist-cascade@proplane.ai",
  subject: "Welcome to Cascade Lofts",
  preview: "Keys will be ready at the office",
  body: "Keys will be ready at the office",
  time: "Jul 16, 2026",
  unread: false,
};

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
  collapsePersonInboxThreads: (threads: unknown[]) => threads,
  inboxThreadCounterpartyEmail: (t: { email?: string }) => t.email ?? "",
  loadPersistedInbox: () => [THREAD],
  syncPersistedInboxFromServer: () => Promise.resolve([THREAD]),
  persistInbox: () => {},
  persistInboxAwait: () => Promise.resolve(true),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: async () => true,
  deleteInboxThreadIds: () => Promise.resolve(true),
  inboxThreadMessages: (t: { id: string; from: string; body: string; time: string }) => [
    { id: `${t.id}-root`, from: t.from, body: t.body, at: t.time },
  ],
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "res-1", email: "resident@example.com", ready: true }),
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
  ],
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ResidentInboxPanel } from "@/components/portal/resident-inbox-panel";

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ rows: [], messages: [], threads: [] }), { status: 200 })),
  );
  render(
    <ResidentInboxPanel
      tabId="all"
      embeddedInCommunication
      externalTitleActions
      suppressListPane
      controlledExpandedId={THREAD.id}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resident thread composer", () => {
  it("has attachment, schedule and channel controls", async () => {
    mount();
    await screen.findByPlaceholderText(/reply/i);
    expect(document.querySelector("[data-attr=resident-inbox-reply-attach]")).toBeTruthy();
    expect(screen.getByRole("button", { name: /schedule for later/i })).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-composer-tools]")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
  });

  it("has no Auto-send, no AI draft button and no assistant strip", async () => {
    mount();
    await screen.findByPlaceholderText(/reply/i);
    expect(screen.queryByText(/auto-send/i)).toBeNull();
    expect(document.querySelector("[data-attr=resident-inbox-reply-auto-send]")).toBeNull();
    expect(screen.queryByRole("button", { name: "AI" })).toBeNull();
    expect(document.querySelector("[data-attr=inbox-composer-ai-menu]")).toBeNull();
    expect(document.querySelector("[data-attr=inbox-ai-draft-generate]")).toBeNull();
    expect(screen.queryByText(/Draft with PropLane/i)).toBeNull();
    expect(screen.queryByText(/Ask PropLane/i)).toBeNull();
  });

  it("schedules the reply instead of sending it when the clock is set", async () => {
    mount();
    const composer = await screen.findByPlaceholderText(/reply/i);
    fireEvent.change(composer, { target: { value: "See you Monday" } });
    // Radix opens its dropdown from the keyboard in jsdom (no PointerEvent).
    fireEvent.keyDown(screen.getByRole("button", { name: /schedule for later/i }), { key: "Enter" });
    const confirm = await screen.findByText(/send at this time/i);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^scheduled for/i })).toBeTruthy(),
    );
  });

  it("titles the thread with the manager and offers manager icon actions", async () => {
    mount();
    await screen.findByPlaceholderText(/reply/i);
    expect(screen.getByText("Cascade Lofts Management")).toBeTruthy();
    expect(screen.getByText(/Property manager · Cascade Lofts/)).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-thread-text-manager]")).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-thread-email-manager]")).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-thread-mark-unread]")).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-thread-archive]")).toBeTruthy();
  });
});
