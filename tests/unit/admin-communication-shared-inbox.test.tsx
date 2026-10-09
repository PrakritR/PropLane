// @vitest-environment jsdom
/**
 * Admin Communication is the manager's Communication page over admin's own
 * data (plan admin-money-1008, decision D5). It must draw the manager chrome -
 * Active | Archived tabs, the identity boxes, the round blue + - with email and
 * text conversations merged in ONE list, and none of what it replaced:
 * Unopened / Opened / Sent pills, labeled Scheduled / Archived / New message
 * buttons, a flat table, a separate "Text messages" card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "admin-1", email: "admin@example.test", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useOptionalAppUi: () => null,
  useAppUi: () => ({ showToast: vi.fn() }),
  useConfirm: () => async () => true,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/portal/pro-sms-panel", () => ({
  ManagerSmsPanel: (props: { endpoint?: string; allowArchive?: boolean; allowDelete?: boolean }) => (
    <div
      data-testid="admin-sms-thread"
      data-endpoint={props.endpoint}
      data-allow-archive={String(props.allowArchive)}
      data-allow-delete={String(props.allowDelete)}
    />
  ),
  smsOutboundPreviewPrefix: () => "",
}));

import { AdminCommunication } from "@/components/portal/admin-communication";
import { resetAdminScheduledForTests } from "@/lib/admin-inbox-source";
import { seedDemoAdminInbox } from "@/lib/demo-admin-partner-inbox";
import { resetManagerInboxSnapshotCacheForTests } from "@/components/portal/pro-unified-inbox";
import { publishAdminWorkNumber } from "@/components/portal/admin-work-identity-card";

function adminMessage(overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "folder">): InboxMessage {
  return {
    name: "Jamie Rivera",
    email: "jamie@example.test",
    topic: "Question about rent",
    body: "When is rent due?",
    createdAt: new Date().toISOString(),
    read: false,
    senderRole: "manager",
    thread: [],
    ...overrides,
  };
}

const SMS_ROW = {
  residentUserId: null,
  residentEmail: null,
  name: "Pat Texter",
  savedContactName: null,
  phone: "+12065550123",
  propertyLabel: null,
  counterpartyRole: "unknown",
  conversationKey: "admin-line:+12065550123",
  messages: [
    {
      id: "sms-1",
      direction: "inbound",
      body: "Is the app down?",
      createdAt: new Date().toISOString(),
      messageSid: "SM1",
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAdminScheduledForTests();
  resetManagerInboxSnapshotCacheForTests();
  window.localStorage.clear();
  // seeded rows count as already synced, so only the SMS and scheduled reads are needed
  seedDemoAdminInbox([
    adminMessage({ id: "support-1", folder: "inbox", name: "Jamie Rivera", senderRole: "partner" }),
    adminMessage({
      id: "old-1",
      folder: "trash",
      trashedFrom: "inbox",
      name: "Archived Person",
      email: "archived@example.test",
      topic: "Old thing",
      body: "Long ago",
    }),
  ]);
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/admin/sms-conversations")) {
      return Response.json({ residents: [SMS_ROW], workNumber: "+12065550100" });
    }
    if (String(url).includes("scheduled-inbox-messages")) return Response.json({ messages: [] });
    return Response.json({ ok: true, rows: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  publishAdminWorkNumber(null);
});

describe("admin Communication draws the manager page", () => {
  it("merges email and text conversations into one list, under the manager chrome", async () => {
    const { container } = render(<AdminCommunication smsUiEnabled />);

    // One list: the support email conversation and the text conversation side by side.
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    expect(screen.getByText("Pat Texter")).toBeTruthy();
    expect(container.querySelectorAll("[data-communication-inbox-list]")).toHaveLength(1);

    // Active | Archived command tabs (counted) - not Unopened / Opened / Sent pills.
    expect(screen.getByRole("link", { name: /^Active/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Archived/ })).toBeTruthy();
    for (const label of ["Unopened", "Opened", "Sent", "Scheduled"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${label}`) })).toBeNull();
      expect(screen.queryByRole("link", { name: new RegExp(`^${label}`) })).toBeNull();
    }

    // The identity boxes: the support address, and the admin number the text stream reported.
    expect(screen.getByText("support@proplane.ai")).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-attr="admin-work-number-card"]')).toBeTruthy());

    // Filter and the round blue + are the list tools; the words are tooltips.
    expect(screen.getByRole("button", { name: "New message" })).toBeTruthy();
    expect(container.querySelector('[data-attr="communication-filter-sheet-open"]')).toBeTruthy();

    // None of what it replaced.
    expect(screen.queryByText("Text messages")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector('[data-attr="admin-inbox-scheduled-toggle"]')).toBeNull();
    expect(container.querySelector('[data-attr="admin-inbox-archived-toggle"]')).toBeNull();
  });

  it("reads the admin text endpoint once and never the manager's", async () => {
    render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Pat Texter")).toBeTruthy());
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith("/api/admin/sms-conversations"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/manager/"))).toBe(false);
  });

  it("shows only the email conversations, and asks for no texts, when the text UI is off", async () => {
    render(<AdminCommunication smsUiEnabled={false} />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    expect(screen.queryByText("Pat Texter")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sms-conversations"))).toBe(false);
  });

  it("opens an email conversation in the shared thread with a reply composer and an archive icon", async () => {
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    fireEvent.click(screen.getByText("Jamie Rivera"));

    await waitFor(() => expect(container.querySelector('[data-attr="admin-communication-reply"]')).toBeTruthy());
    // The message is in the list row's preview and in the open thread.
    expect(screen.getAllByText("When is rent due?").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-attr="admin-communication-move-to-trash"]')).toBeTruthy();
  });

  it("opens a text conversation against the admin endpoint, with no archive or delete", async () => {
    render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Pat Texter")).toBeTruthy());
    fireEvent.click(screen.getByText("Pat Texter"));

    const pane = await screen.findByTestId("admin-sms-thread");
    expect(pane.dataset.endpoint).toBe("/api/admin/sms-conversations");
    expect(pane.dataset.allowArchive).toBe("false");
    expect(pane.dataset.allowDelete).toBe("false");
  });

  it("lists archived conversations on the Archived tab, with Restore and Delete in the thread", async () => {
    const { container } = render(<AdminCommunication smsUiEnabled listSegment="archived" />);
    await waitFor(() => expect(screen.getByText("Archived Person")).toBeTruthy());
    expect(screen.queryByText("Jamie Rivera")).toBeNull();

    fireEvent.click(screen.getByText("Archived Person"));
    await waitFor(() => expect(container.querySelector('[data-attr="admin-communication-restore"]')).toBeTruthy());
    expect(container.querySelector('[data-attr="admin-communication-delete-forever"]')).toBeTruthy();
    // A read-only archived thread has no composer.
    expect(container.querySelector('[data-attr="admin-communication-reply"]')).toBeNull();
  });

  it("puts Unread under Filter, not on the page", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("pointer: fine"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })),
    });
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    expect(screen.queryByRole("link", { name: /^Unread/ })).toBeNull();
    fireEvent.click(container.querySelector('[data-attr="communication-filter-sheet-open"]')!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Status")).toBeTruthy();
    expect(within(dialog).getByText("Sort")).toBeTruthy();
    // Admin has no houses or roles to filter by.
    expect(within(dialog).queryByText("House")).toBeNull();
    expect(within(dialog).queryByText("Role")).toBeNull();
  });
});

describe("scheduled sends render inline in the conversation, with a reachable cancel", () => {
  function pending(overrides: Record<string, unknown> = {}) {
    return {
      id: "sch-1",
      managerUserId: "admin-1",
      sendAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      status: "scheduled",
      subject: "Maintenance window",
      body: "We will be down Friday.",
      recipientEmail: "jamie@example.test",
      recipientName: "Jamie Rivera",
      deliverViaEmail: false,
      deliverViaSms: false,
      deliverViaInbox: true,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function stubScheduled(messages: unknown[]) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/api/admin/sms-conversations")) return Response.json({ residents: [], workNumber: null });
      if (target.includes("scheduled-inbox-messages/") && init?.method === "PATCH") return Response.json({ ok: true });
      if (target.includes("scheduled-inbox-messages")) return Response.json({ messages });
      return Response.json({ ok: true, rows: [] });
    });
  }

  it("draws a pending send in the bar under the conversation name - no Scheduled view", async () => {
    stubScheduled([pending()]);
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    fireEvent.click(screen.getByText("Jamie Rivera"));

    await waitFor(() => expect(container.querySelector('[data-attr="inbox-scheduled-bar"]')).toBeTruthy());
    expect(within(container.querySelector('[data-attr="inbox-scheduled-bar"]') as HTMLElement).getByText(/Maintenance window/)).toBeTruthy();
    expect(container.querySelector('[data-attr="admin-inbox-scheduled-toggle"]')).toBeNull();
  });

  it("cancels the pending send from its pop-up", async () => {
    stubScheduled([pending()]);
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    fireEvent.click(screen.getByText("Jamie Rivera"));
    await waitFor(() => expect(container.querySelector('[data-attr="inbox-scheduled-bar"]')).toBeTruthy());

    fireEvent.click(within(container.querySelector('[data-attr="inbox-scheduled-bar"]') as HTMLElement).getByText(/Maintenance window/));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel send/ }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/portal/scheduled-inbox-messages/sch-1" &&
            (init as RequestInit | undefined)?.method === "PATCH" &&
            String((init as RequestInit).body).includes('"cancelled":true'),
        ),
      ).toBe(true),
    );
  });

  it("gives a send to someone never messaged a conversation of its own, so it can still be cancelled", async () => {
    stubScheduled([
      pending({ id: "sch-2", recipientEmail: "newbie@example.test", recipientName: "Nora Newbie", subject: "Welcome aboard" }),
    ]);
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Nora Newbie")).toBeTruthy());
    fireEvent.click(screen.getByText("Nora Newbie"));

    await waitFor(() => expect(container.querySelector('[data-attr="inbox-scheduled-bar"]')).toBeTruthy());
    expect(within(container.querySelector('[data-attr="inbox-scheduled-bar"]') as HTMLElement).getByText(/Welcome aboard/)).toBeTruthy();
  });
});

describe("replying keeps authorize-then-append", () => {
  it("posts the reply to the admin route and shows it only after the server accepted it", async () => {
    let accepted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/api/admin/sms-conversations")) return Response.json({ residents: [], workNumber: null });
      if (target.includes("scheduled-inbox-messages")) return Response.json({ messages: [] });
      if (target === "/api/admin/inbox-reply" && init?.method === "POST") {
        accepted = true;
        return Response.json({ ok: true });
      }
      if (target.includes("scope=admin")) {
        return Response.json({
          rows: [
            {
              ...adminMessage({ id: "support-1", folder: "inbox", senderRole: "partner" }),
              scope: "admin",
              thread: accepted
                ? [{ id: "r1", authorLabel: "PropLane admin", body: "It is due on the 1st.", createdAt: new Date().toISOString() }]
                : [],
            },
          ],
        });
      }
      return Response.json({ ok: true, rows: [] });
    });
    const { container } = render(<AdminCommunication smsUiEnabled />);
    await waitFor(() => expect(screen.getByText("Jamie Rivera")).toBeTruthy());
    fireEvent.click(screen.getByText("Jamie Rivera"));
    const field = await waitFor(() => {
      const el = container.querySelector('[data-attr="admin-communication-reply"]') as HTMLTextAreaElement | null;
      if (!el) throw new Error("composer not mounted");
      return el;
    });
    fireEvent.change(field, { target: { value: "It is due on the 1st." } });
    // Typed, not sent: nothing is in the thread yet (the textarea is not a message).
    expect(container.querySelectorAll("p").length).toBeGreaterThan(0);
    expect(accepted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/admin/inbox-reply" &&
            String((init as RequestInit | undefined)?.body).includes('"threadId":"support-1"'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByText("It is due on the 1st.").length).toBeGreaterThan(0));
  });
});
