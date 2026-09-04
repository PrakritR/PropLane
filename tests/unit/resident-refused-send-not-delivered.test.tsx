// @vitest-environment jsdom
//
// A send the server REFUSES must never render as delivered.
//
// The resident portal used to write the reply into the thread store BEFORE
// asking the server to send it. `POST /api/portal/send-inbox-message` then
// answered 403 ("You can only message people connected to your account.") while
// `POST /api/portal-inbox-threads` had already answered 200 — so the message sat
// in the store, the conversation list previewed it as "You: …", and the only
// failure signal was a small red caption inside the opened thread. Residents
// reasonably concluded their maintenance request had been delivered.
//
// This pins the corrected order: nothing is persisted until a channel actually
// succeeds, the optimistic bubble is withdrawn on refusal, the resident keeps
// their draft, and they are told WHY.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const THREAD = {
  id: "res-thr-1000000001",
  folder: "inbox" as const,
  from: "Test Manager",
  email: "manager@example.com",
  subject: "Welcome to The Pioneer",
  preview: "Keys will be ready at the office",
  body: "Keys will be ready at the office",
  time: "Jul 16, 2026",
  unread: false,
};

const upsertPersistedInboxRows = vi.fn(async () => true);
const persistInbox = vi.fn();

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  RESIDENT_INBOX_STORAGE_KEY: "resident-inbox",
  collapsePersonInboxThreads: (threads: unknown[]) => threads,
  inboxThreadCounterpartyEmail: (t: { email?: string }) => t.email ?? "",
  loadPersistedInbox: () => [THREAD],
  syncPersistedInboxFromServer: () => Promise.resolve([THREAD]),
  persistInbox: (...args: unknown[]) => persistInbox(...args),
  persistInboxAwait: () => Promise.resolve(true),
  invalidatePersistedInboxCache: () => {},
  inboxMutationInFlight: () => false,
  runInboxMutation: (fn: () => unknown) => fn(),
  stagePersistedInboxRows: () => {},
  upsertPersistedInboxRows: (...args: unknown[]) => upsertPersistedInboxRows(...(args as [])),
  deleteInboxThreadIds: () => Promise.resolve(true),
  formatInboxStamp: (value: Date) =>
    value.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  // Must surface appended replies, not just the root message — otherwise the
  // "optimistic bubble is withdrawn" assertion below can never see one and
  // passes vacuously against the buggy code too.
  inboxThreadMessages: (t: {
    id: string;
    from: string;
    body: string;
    time: string;
    messages?: { id: string; from: string; body: string; at: string }[];
  }) => [{ id: `${t.id}-root`, from: t.from, body: t.body, at: t.time }, ...(t.messages ?? [])],
  appendReplyToInboxThread: (
    thread: Record<string, unknown>,
    reply: { body: string; id: string; from: string; at: string },
  ) => ({
    ...thread,
    preview: reply.body,
    messages: [...((thread.messages as unknown[]) ?? []), reply],
  }),
}));

vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "res-1", email: "resident@example.com", name: "Test Resident", ready: true }),
}));

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: (msg: string) => showToast(msg) }),
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

import { ResidentInboxPanel } from "@/components/portal/resident-inbox-panel";

const REFUSAL = "You can only message people connected to your account.";

/** Route every request the panel makes; only the send endpoint varies per test. */
function stubFetch(sendResponse: { status: number; body: Record<string, unknown> }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/portal/send-inbox-message")) {
        return new Response(JSON.stringify(sendResponse.body), { status: sendResponse.status });
      }
      return new Response(JSON.stringify({ rows: [], messages: [], threads: [] }), { status: 200 });
    }),
  );
  return calls;
}

/**
 * Two-channel variant: the panel posts email first, then SMS, to the SAME
 * endpoint, so responses are handed out in call order.
 */
function stubFetchSequence(sendResponses: { status: number; body: Record<string, unknown> }[]) {
  let sendCall = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/portal/send-inbox-message")) {
        const next = sendResponses[Math.min(sendCall, sendResponses.length - 1)]!;
        sendCall += 1;
        return new Response(JSON.stringify(next.body), { status: next.status });
      }
      if (url.includes("/api/resident/sms-conversations")) {
        return new Response(JSON.stringify({ smsConfigured: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ rows: [], messages: [], threads: [] }), { status: 200 });
    }),
  );
}

/**
 * Select email + SMS through the real channel picker (PropLane off) so dual-channel
 * send tests exercise the same two-request path a resident uses.
 */
async function enableEmailAndSmsChannels() {
  await waitFor(() => expect(document.querySelectorAll('[aria-label="Send via"]').length).toBeGreaterThan(0));
  const picker = document.querySelectorAll('[aria-label="Send via"]')[0] as HTMLElement;
  fireEvent.click(picker);
  const tapOption = async (name: RegExp) => {
    const option = await screen.findByRole("option", { name });
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  };
  await tapOption(/^Email$/i);
  await tapOption(/^SMS$/i);
  await tapOption(/^PropLane$/i);
  await waitFor(() => expect(picker.textContent).toContain("Email & SMS"));
}

async function openThreadAndReply(text: string) {
  // Same mount shape Communication uses in the real portal (resident-communication.tsx).
  render(
    <ResidentInboxPanel
      tabId="all"
      embeddedInCommunication
      externalTitleActions
      suppressListPane
      controlledExpandedId={THREAD.id}
    />,
  );
  const composer = await screen.findByPlaceholderText(/reply/i);
  fireEvent.change(composer, { target: { value: text } });
  const send = document.querySelector("[data-attr=resident-inbox-reply-send]") as HTMLButtonElement | null;
  expect(send).toBeTruthy();
  fireEvent.click(send!);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  upsertPersistedInboxRows.mockClear();
  persistInbox.mockClear();
  showToast.mockClear();
});

describe("resident reply that the server refuses", () => {
  it("never writes the refused message to the thread store", async () => {
    stubFetch({ status: 403, body: { ok: false, error: REFUSAL } });
    await openThreadAndReply("REFUSED probe");

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    // The store is the thing the conversation list previews from. A refused
    // message reaching it is what made the send look delivered.
    expect(upsertPersistedInboxRows).not.toHaveBeenCalled();
    for (const call of persistInbox.mock.calls) {
      const rows = (call[1] ?? []) as { preview?: string }[];
      expect(rows.some((row) => row.preview === "REFUSED probe")).toBe(false);
    }
  });

  it("withdraws the optimistic bubble and keeps the resident's draft", async () => {
    stubFetch({ status: 403, body: { ok: false, error: REFUSAL } });
    await openThreadAndReply("REFUSED probe");

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    // Scoped to message bubbles: the composer legitimately still holds the same
    // text, and that is the point of the next assertion.
    const bubbles = [...document.querySelectorAll(".portal-inbox-inbound-bubble, .portal-inbox-outbound-bubble")];
    expect(bubbles.some((b) => b.textContent?.includes("REFUSED probe"))).toBe(false);
    const composer = screen.getByPlaceholderText(/reply/i) as HTMLTextAreaElement;
    expect(composer.value).toBe("REFUSED probe");
  });

  it("tells the resident why, rather than a generic failure", async () => {
    stubFetch({ status: 403, body: { ok: false, error: REFUSAL } });
    await openThreadAndReply("REFUSED probe");

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(REFUSAL));
  });

  it("still persists a reply the server accepts", async () => {
    stubFetch({ status: 200, body: { ok: true } });
    await openThreadAndReply("ACCEPTED probe");

    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const [, changedRows] = upsertPersistedInboxRows.mock.calls[0] as unknown as [string, { preview?: string }[]];
    expect(changedRows.some((row) => row.preview === "ACCEPTED probe")).toBe(true);
  });
});

/**
 * A partly-delivered reply must be reported for what it is. The message DID go
 * out over email, so withdrawing the bubble would be the refused-send bug in
 * reverse — but claiming "sent via email and text" is the same lie about
 * delivery that this file exists to pin, just on the SMS half.
 */
describe("resident reply where one channel succeeds and the other fails", () => {
  async function replyOverBothChannels(
    text: string,
    responses: { status: number; body: Record<string, unknown> }[],
  ) {
    stubFetchSequence(responses);
    render(
      <ResidentInboxPanel
        tabId="all"
        embeddedInCommunication
        externalTitleActions
        suppressListPane
        smsUiEnabled
        controlledExpandedId={THREAD.id}
      />,
    );
    // Turn the SMS leg on through the real channel picker, so the test exercises
    // the same two-request path a resident does.
    await enableEmailAndSmsChannels();

    const composer = await screen.findByPlaceholderText(/reply/i);
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.click(document.querySelector("[data-attr=resident-inbox-reply-send]") as HTMLButtonElement);
  }

  it("keeps the delivered reply but names the SMS failure", async () => {
    await replyOverBothChannels("PARTIAL probe", [
      { status: 200, body: { ok: true } },
      { status: 500, body: { ok: false, error: "sms gateway down" } },
    ]);

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith("Reply sent via email. Text message failed.");
    // Email accepted it, so the reply is delivered and must reach the store.
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const [, changedRows] = upsertPersistedInboxRows.mock.calls[0] as unknown as [string, { preview?: string }[]];
    expect(changedRows.some((row) => row.preview === "PARTIAL probe")).toBe(true);
  });

  it("keeps the delivered reply when the SMS request rejects outright", async () => {
    let sendCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/portal/send-inbox-message")) {
          sendCall += 1;
          if (sendCall > 1) throw new TypeError("Failed to fetch");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/api/resident/sms-conversations")) {
          return new Response(JSON.stringify({ smsConfigured: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ rows: [], messages: [], threads: [] }), { status: 200 });
      }),
    );
    render(
      <ResidentInboxPanel
        tabId="all"
        embeddedInCommunication
        externalTitleActions
        suppressListPane
        smsUiEnabled
        controlledExpandedId={THREAD.id}
      />,
    );
    await enableEmailAndSmsChannels();
    const composer = await screen.findByPlaceholderText(/reply/i);
    fireEvent.change(composer, { target: { value: "REJECTED SMS probe" } });
    fireEvent.click(document.querySelector("[data-attr=resident-inbox-reply-send]") as HTMLButtonElement);

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith("Reply sent via email. Text message failed.");
    await waitFor(() => expect(upsertPersistedInboxRows).toHaveBeenCalled());
    const bubbles = [...document.querySelectorAll(".portal-inbox-outbound-bubble")];
    expect(bubbles.some((b) => b.textContent?.includes("REJECTED SMS probe"))).toBe(true);
  });
});
