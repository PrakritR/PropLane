// @vitest-environment jsdom
//
// C1-R4: a resident's thread header names the server-stamped counterparty, and
// a text-only conversation is read-only - the composer is replaced by one
// "Text <work number>" action (an sms: link), never an in-app send.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const THREAD = {
  id: "resident_sms_ws-1",
  folder: "inbox" as const,
  from: "Dana Whitfield",
  email: "",
  subject: "Text messages",
  preview: "Keys are ready",
  body: "Keys are ready",
  time: "Jul 16, 2026",
  unread: false,
  conversationKey: "ws:ws-1",
  smsOnly: true,
  counterparty: {
    workspaceId: "ws-1",
    name: "Dana Whitfield",
    workspaceName: "Cascade Lofts Management",
    workPhone: "+15103098345",
    avatarUrl: null,
    initials: "DW",
  },
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
  // No contact matches: identity comes from the server-stamped counterparty alone.
  useResidentManagerContacts: () => [],
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

describe("resident text-only conversation", () => {
  it("titles the thread with the stamped manager and workspace, not a client email match", async () => {
    mount();
    await screen.findByText("Dana Whitfield");
    expect(screen.getByText(/Cascade Lofts Management/)).toBeTruthy();
    expect(screen.queryByText("Property manager")).toBeNull();
  });

  it("replaces the composer with a Text <work number> sms link", async () => {
    mount();
    const action = await waitFor(() => {
      const el = document.querySelector("[data-attr=resident-inbox-text-manager]");
      expect(el).toBeTruthy();
      return el as HTMLAnchorElement;
    });
    expect(action.getAttribute("href")).toBe("sms:+15103098345");
    expect(action.textContent).toMatch(/Text\s*\+?1?\s*\(?510\)?\s*309-8345/);
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
    expect(document.querySelector("[data-attr=resident-inbox-reply]")).toBeNull();
  });

  it("offers no mark-unread or archive on a derived row", async () => {
    mount();
    await screen.findByText("Dana Whitfield");
    expect(document.querySelector("[data-attr=inbox-thread-text-manager]")).toBeTruthy();
    expect(document.querySelector("[data-attr=inbox-thread-mark-unread]")).toBeNull();
    expect(document.querySelector("[data-attr=inbox-thread-archive]")).toBeNull();
  });
});
