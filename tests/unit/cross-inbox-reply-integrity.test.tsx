// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const BASE_THREAD = {
  id: "thread-1",
  folder: "inbox" as const,
  from: "Resident One",
  email: "resident@example.com",
  subject: "A question",
  preview: "Original message",
  body: "Original message",
  time: "Aug 20, 9:00 AM",
  unread: false,
  // Keep manager AI drafting inactive while this reply behavior is exercised.
  messages: [
    {
      id: "inbound-2",
      from: "Resident One",
      body: "One more detail",
      at: "Aug 20, 9:05 AM",
      outbound: false,
    },
  ],
};

let managerRows = [{ ...BASE_THREAD }];
let vendorRows = [{ ...BASE_THREAD }];
const upsertPersistedInboxRows = vi.fn(async () => true);
const showToast = vi.fn();

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MANAGER_INBOX_STORAGE_KEY: "manager-inbox",
  VENDOR_INBOX_STORAGE_KEY: "vendor-inbox",
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
  resolveCollapsedInboxThread: (
    id: string | null,
    rows: Array<{ id: string }>,
  ) => rows.find((row) => row.id === id) ?? null,
  inboxThreadCounterpartyEmail: (row: { email?: string }) => row.email ?? "",
  loadPersistedInbox: (key: string) =>
    key === "manager-inbox" ? managerRows : vendorRows,
  syncPersistedInboxFromServer: (key: string) =>
    Promise.resolve(key === "manager-inbox" ? managerRows : vendorRows),
  persistInbox: () => {},
  persistInboxAwait: () => Promise.resolve(true),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: (...args: unknown[]) =>
    upsertPersistedInboxRows(...(args as [])),
  deleteInboxThreadIds: () => Promise.resolve(true),
  inboxThreadSortMs: () => 1,
  formatInboxStamp: () => "Aug 26, 9:45 AM",
  // Keep AI drafting off for this reply-refusal case.
  inboxThreadManagerReplyPending: () => false,
  inboxThreadMessages: (thread: typeof BASE_THREAD) => [
    {
      id: `${thread.id}-root`,
      from: thread.from,
      body: thread.body,
      at: thread.time,
      outbound: false,
    },
    ...(thread.messages ?? []),
  ],
  appendReplyToInboxThread: (
    thread: typeof BASE_THREAD,
    reply: (typeof BASE_THREAD.messages)[number] & { delivery?: string },
  ) => ({
    ...thread,
    messages: [...(thread.messages ?? []), reply],
    preview: reply.body,
    time: reply.at,
    unread: false,
  }),
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({
    userId: "manager-1",
    email: "manager@example.com",
    ready: true,
  }),
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => () => {},
}));
vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [], reload: () => {} }),
}));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({
  ManagerInboxSchedulePanel: () => null,
}));
vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/portal/inbox-thread-assistant-strip", () => ({
  buildInboxThreadAssistantContext: () => ({}),
  InboxThreadAssistantStrip: () => null,
}));

import { ManagerInbox } from "@/components/portal/pro-inbox";
import { VendorInboxPanel } from "@/components/portal/vendor-inbox-panel";

function responseForBackground(url: string): Response {
  if (url.includes("inbox-eligible-contacts"))
    return Response.json({ contacts: [] });
  if (url.includes("vendor/profile"))
    return Response.json({
      profile: { name: "Vendor One", email: "vendor@example.com" },
    });
  return Response.json({ messages: [] });
}

async function typeAndSend(dataAttr: string, text: string) {
  const input = await screen.findByPlaceholderText("Write a reply…");
  fireEvent.change(input, { target: { value: text } });
  const send = document.querySelector(
    `[data-attr="${dataAttr}-send"]`,
  ) as HTMLButtonElement | null;
  expect(send).toBeTruthy();
  fireEvent.click(send!);
  return input as HTMLTextAreaElement;
}

beforeEach(() => {
  managerRows = [{ ...BASE_THREAD, messages: [...BASE_THREAD.messages] }];
  vendorRows = [{ ...BASE_THREAD, messages: [...BASE_THREAD.messages] }];
  upsertPersistedInboxRows.mockClear();
  showToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("manager and vendor inbox reply integrity", () => {
  it("withdraws a manager reply refused by the server and keeps the draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("send-inbox-message") && init?.method === "POST") {
          return Response.json(
            { error: "This conversation is no longer available." },
            { status: 403 },
          );
        }
        return responseForBackground(url);
      }),
    );
    render(
      <ManagerInbox
        tabId="all"
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        controlledExpandedId="thread-1"
      />,
    );

    const input = await typeAndSend("inbox-reply", "Manager refused reply");

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "This conversation is no longer available.",
      ),
    );
    expect(input).toHaveValue("Manager refused reply");
    expect(upsertPersistedInboxRows).not.toHaveBeenCalled();
    expect(
      [...document.querySelectorAll(".portal-inbox-outbound-bubble")].some(
        (bubble) => bubble.textContent?.includes("Manager refused reply"),
      ),
    ).toBe(false);
  });

  it("withdraws a vendor reply refused by the server and keeps the draft", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("send-inbox-message") && init?.method === "POST") {
          return Response.json(
            { error: "This conversation is no longer available." },
            { status: 403 },
          );
        }
        return responseForBackground(url);
      }),
    );
    render(
      <VendorInboxPanel
        tabId="all"
        embeddedInCommunication
        externalTitleActions
        suppressListPane
        controlledExpandedId="thread-1"
      />,
    );

    const input = await typeAndSend(
      "vendor-inbox-reply",
      "Vendor refused reply",
    );

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "This conversation is no longer available.",
      ),
    );
    expect(input).toHaveValue("Vendor refused reply");
    expect(upsertPersistedInboxRows).not.toHaveBeenCalled();
    expect(
      [...document.querySelectorAll(".portal-inbox-outbound-bubble")].some(
        (bubble) => bubble.textContent?.includes("Vendor refused reply"),
      ),
    ).toBe(false);
  });

  it("persists an accepted vendor reply and renders it on the outbound side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("send-inbox-message") && init?.method === "POST") {
          return Response.json({ ok: true });
        }
        return responseForBackground(url);
      }),
    );
    render(
      <VendorInboxPanel
        tabId="all"
        embeddedInCommunication
        externalTitleActions
        suppressListPane
        controlledExpandedId="thread-1"
      />,
    );

    await typeAndSend("vendor-inbox-reply", "Accepted vendor reply");

    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const outbound = [
      ...document.querySelectorAll(".portal-inbox-outbound-bubble"),
    ];
    expect(
      outbound.some((bubble) =>
        bubble.textContent?.includes("Accepted vendor reply"),
      ),
    ).toBe(true);
    expect(showToast).toHaveBeenCalledWith("Reply sent.");
  });
});
