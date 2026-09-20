// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
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
let residentRows = [{ ...BASE_THREAD }];
const upsertPersistedInboxRows = vi.fn(async () => true);
const showToast = vi.fn();

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MANAGER_INBOX_STORAGE_KEY: "manager-inbox",
  VENDOR_INBOX_STORAGE_KEY: "vendor-inbox",
  RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  collapsePersonInboxThreads: (rows: unknown[]) => rows,
  resolveCollapsedInboxThread: (
    id: string | null,
    rows: Array<{ id: string }>,
  ) => rows.find((row) => row.id === id) ?? null,
  inboxThreadCounterpartyEmail: (row: { email?: string }) => row.email ?? "",
  loadPersistedInbox: (key: string) => key === "manager-inbox" ? managerRows : key === "resident-inbox" ? residentRows : vendorRows,
  syncPersistedInboxFromServer: (key: string) => Promise.resolve(key === "manager-inbox" ? managerRows : key === "resident-inbox" ? residentRows : vendorRows),
  syncPersistedInboxFromServerWithStatus: (key: string) =>
    Promise.resolve({ rows: key === "manager-inbox" ? managerRows : key === "resident-inbox" ? residentRows : vendorRows, ok: true }),
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
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({
    userId: "manager-1",
    email: "vendor@example.com",
    ready: true,
  }),
}));
vi.mock("@/lib/auth/portal-session-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-session-gate")>()),
  portalSessionViewerId: () => "manager-1",
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => () => {},
}));
vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast }),
}));
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  useScheduledPaymentMessages: () => ({ messages: [], reload: () => {} }),
}));
vi.mock("@/components/portal/pro-inbox-schedule-panel", () => ({
  ManagerInboxSchedulePanel: () => null,
}));
vi.mock("@/lib/manager-inbox-contacts", async (importOriginal) => ({
  // Spread the real module: this file only needs an empty live directory, and a
  // hand-listed mock silently breaks every time the module gains an export a
  // component calls — which is exactly how this broke.
  ...(await importOriginal<typeof import("@/lib/manager-inbox-contacts")>()),
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
import { ResidentInboxPanel } from "@/components/portal/resident-inbox-panel";

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
  residentRows = [{ ...BASE_THREAD, messages: [...BASE_THREAD.messages] }];
  upsertPersistedInboxRows.mockClear();
  showToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("manager and vendor inbox reply integrity", () => {
  it("advances only approved draft A and preserves queued B/C plus newer cache rows", async () => {
    const draftA = { text: "Draft A", status: "pending_approval" as const, generatedAt: "draft-a" };
    const draftB = { text: "Draft B", status: "pending_approval" as const, generatedAt: "draft-b" };
    const draftC = { text: "Draft C", status: "pending_approval" as const, generatedAt: "draft-c" };
    managerRows = [{ ...BASE_THREAD, aiDraft: draftA, aiDraftQueue: [draftB, draftC] }] as unknown as typeof managerRows;
    let resolveSend!: () => void;
    const send = new Promise<void>((resolve) => { resolveSend = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") {
        await send;
        return Response.json({ ok: true });
      }
      return responseForBackground(url);
    }));

    render(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("inbox-reply", "Approve only A");
    managerRows = [{
      ...BASE_THREAD,
      aiDraft: { ...draftA, model: "newer-metadata" },
      aiDraftQueue: [draftB, draftC],
      messages: [...BASE_THREAD.messages, { id: "late-inbound", from: "Resident One", body: "Late inbound", at: "Aug 20, 9:10 AM", outbound: false }],
    }, { ...BASE_THREAD, id: "queue-sibling", subject: "Queue sibling" }] as unknown as typeof managerRows;

    await act(async () => resolveSend());
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const persisted = upsertPersistedInboxRows.mock.calls.at(-1)?.[2] as Array<{
      id: string;
      aiDraft?: { text: string; generatedAt?: string };
      aiDraftQueue?: Array<{ text: string; generatedAt?: string }>;
      resolvedAiDraftIds?: string[];
      messages?: Array<{ id: string; body: string }>;
    }>;
    expect(persisted.map((row) => row.id)).toContain("queue-sibling");
    expect(persisted[0]?.messages?.some((message) => message.id === "late-inbound")).toBe(true);
    expect(persisted[0]?.aiDraft).toMatchObject({ text: "Draft B", generatedAt: "draft-b" });
    expect(persisted[0]?.aiDraftQueue).toEqual([expect.objectContaining({ text: "Draft C", generatedAt: "draft-c" })]);
    expect(persisted[0]?.resolvedAiDraftIds).toContain("draft-a");
  });

  it("leaves draft A and queued B/C unchanged when manager delivery is refused", async () => {
    const draftA = { text: "Draft A", status: "pending_approval" as const, generatedAt: "draft-a" };
    const draftB = { text: "Draft B", status: "pending_approval" as const, generatedAt: "draft-b" };
    const draftC = { text: "Draft C", status: "pending_approval" as const, generatedAt: "draft-c" };
    managerRows = [{ ...BASE_THREAD, aiDraft: draftA, aiDraftQueue: [draftB, draftC] }] as unknown as typeof managerRows;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("send-inbox-message") && init?.method === "POST") {
        return Response.json({ error: "Delivery refused." }, { status: 403 });
      }
      return responseForBackground(String(input));
    }));

    render(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("inbox-reply", "Do not consume A");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Delivery refused."));

    const current = managerRows[0] as typeof BASE_THREAD & {
      aiDraft?: typeof draftA;
      aiDraftQueue?: Array<typeof draftB>;
    };
    expect(current.aiDraft).toEqual(draftA);
    expect(current.aiDraftQueue).toEqual([draftB, draftC]);
    expect(upsertPersistedInboxRows).not.toHaveBeenCalled();
  });

  it("does not let an old X-Y-X reply completion clear a newer same-thread draft", async () => {
    managerRows = [
      { ...BASE_THREAD },
      { ...BASE_THREAD, id: "thread-2", from: "Resident Two", email: "resident-two@example.com" },
    ];
    let sendNumber = 0;
    let resolveOldSend!: () => void;
    const oldSend = new Promise<void>((resolve) => { resolveOldSend = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") {
        sendNumber += 1;
        if (sendNumber === 1) await oldSend;
        return Response.json({ ok: true });
      }
      return responseForBackground(url);
    }));

    const view = render(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("inbox-reply", "Old X reply");
    view.rerender(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-2" />);
    view.rerender(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-1" />);

    await typeAndSend("inbox-reply", "New X reply");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Reply sent."));
    const input = await screen.findByPlaceholderText("Write a reply…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Newest unsent X draft" } });

    await act(async () => resolveOldSend());
    await waitFor(() => expect(input).toHaveValue("Newest unsent X draft"));
    expect(sendNumber).toBe(2);
  });

  it("commits an accepted manager reply onto the latest cache, retaining a late inbound turn and sibling row", async () => {
    let resolveSend!: () => void;
    const send = new Promise<void>((resolve) => { resolveSend = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") {
        await send;
        return Response.json({ ok: true });
      }
      return responseForBackground(url);
    }));
    render(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions suppressCompose suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("inbox-reply", "Reply survives cache race");
    managerRows = [{
      ...BASE_THREAD,
      messages: [...BASE_THREAD.messages, { id: "late-inbound", from: "Resident One", body: "Late inbound", at: "Aug 20, 9:10 AM", outbound: false }],
    }, { ...BASE_THREAD, id: "sibling-row", subject: "Sibling must survive" }];
    await act(async () => resolveSend());
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const persisted = upsertPersistedInboxRows.mock.calls.at(-1)?.[2] as typeof managerRows;
    expect(persisted.map((row) => row.id)).toContain("sibling-row");
    expect(persisted[0]?.messages?.some((message) => message.id === "late-inbound")).toBe(true);
    expect(persisted[0]?.messages?.some((message) => message.body === "Reply survives cache race")).toBe(true);
  });

  it("commits an accepted vendor reply onto the latest cache, retaining a late inbound turn and sibling row", async () => {
    let resolveSend!: () => void;
    const send = new Promise<void>((resolve) => { resolveSend = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") {
        await send;
        return Response.json({ ok: true });
      }
      return responseForBackground(url);
    }));
    render(<VendorInboxPanel tabId="all" embeddedInCommunication externalTitleActions suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("vendor-inbox-reply", "Vendor cache race reply");
    vendorRows = [{
      ...BASE_THREAD,
      messages: [...BASE_THREAD.messages, { id: "late-inbound", from: "Resident One", body: "Late inbound", at: "Aug 20, 9:10 AM", outbound: false }],
    }, { ...BASE_THREAD, id: "vendor-sibling", subject: "Sibling must survive" }];
    await act(async () => resolveSend());
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const persisted = upsertPersistedInboxRows.mock.calls.at(-1)?.[2] as typeof vendorRows;
    expect(persisted.map((row) => row.id)).toContain("vendor-sibling");
    expect(persisted[0]?.messages?.some((message) => message.id === "late-inbound")).toBe(true);
    expect(persisted[0]?.messages?.some((message) => message.body === "Vendor cache race reply")).toBe(true);
  });

  it("commits an accepted resident reply onto the latest cache, retaining a late inbound turn and sibling row", async () => {
    let resolveSend!: () => void;
    const send = new Promise<void>((resolve) => { resolveSend = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") { await send; return Response.json({ ok: true }); }
      return responseForBackground(url);
    }));
    render(<ResidentInboxPanel tabId="all" embeddedInCommunication externalTitleActions suppressListPane controlledExpandedId="thread-1" />);
    await typeAndSend("resident-inbox-reply", "Resident cache race reply");
    residentRows = [{ ...BASE_THREAD, messages: [...BASE_THREAD.messages, { id: "late-inbound", from: "Manager", body: "Late inbound", at: "Aug 20, 9:10 AM", outbound: false }] }, { ...BASE_THREAD, id: "resident-sibling", subject: "Sibling must survive" }];
    await act(async () => resolveSend());
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const persisted = upsertPersistedInboxRows.mock.calls.at(-1)?.[2] as typeof residentRows;
    expect(persisted.map((row) => row.id)).toContain("resident-sibling");
    expect(persisted[0]?.messages?.some((message) => message.id === "late-inbound")).toBe(true);
    expect(persisted[0]?.messages?.some((message) => message.body === "Resident cache race reply")).toBe(true);
  });

  it("reports a PropLane-only assistant reply as sent without contacting email or SMS", async () => {
    managerRows = [{ ...BASE_THREAD, id: "agent_notice_manager-1", from: "PropLane Assistant", email: "" }];
    const sends: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("send-inbox-message") && init?.method === "POST") {
        sends.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, agentHandled: true });
      }
      return responseForBackground(url);
    }));
    render(<ManagerInbox tabId="all" embeddedInCommunication externalTitleActions
      suppressCompose suppressListPane controlledExpandedId="agent_notice_manager-1" />);
    const input = await typeAndSend("inbox-reply", "Check my pending requests");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Reply sent via PropLane."));
    expect(showToast).not.toHaveBeenCalledWith("Could not send reply.");
    expect(input).toHaveValue("");
    expect(sends).toEqual([expect.objectContaining({
      threadId: "agent_notice_manager-1", deliverToPortalInbox: true,
      deliverViaEmail: false, deliverViaSms: false,
    })]);
    expect(sends[0]).not.toHaveProperty("toEmails");
    expect(sends[0]).not.toHaveProperty("toUserIds");
    expect(upsertPersistedInboxRows).toHaveBeenCalled();
  });
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
