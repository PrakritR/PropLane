// @vitest-environment jsdom
//
// The record page's Communication tab renders ONE thread, never the inbox
// chrome (search box, Active/Archived segments, work-number/work-email
// identity cards, conversation list) — see the design contract in
// `docs/agents/communication-inbox.md` § recordRef and the PR description.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

type FixtureThread = Record<string, unknown>;

let threadRows: FixtureThread[] = [];
/** Local cache read, separate from `threadRows` (the SERVER's answer) — a
 *  cold reload starts with an empty local cache even when the server has
 *  the thread, which is exactly the race `initialSyncDone` guards against. */
let localCacheRows: FixtureThread[] | null = null;
/** When set, `syncPersistedInboxFromServer` awaits it instead of resolving
 *  immediately — lets a test observe the state BEFORE the first sync lands. */
let syncGate: Promise<void> | null = null;

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadPersistedInbox: (_key: string, fallback: unknown[]) => localCacheRows ?? threadRows ?? fallback,
    syncPersistedInboxFromServer: async () => {
      if (syncGate) await syncGate;
      // The real implementation persists what it fetches, so a subsequent
      // loadPersistedInbox() call reflects the server's answer.
      localCacheRows = threadRows;
      return threadRows;
    },
  };
});

import { RecordCommunicationSection } from "@/components/portal/record-communication-section";

const LEASE_REF = { kind: "lease" as const, id: "lease-1", label: "Lease #100" };

const LEASE_THREAD: FixtureThread = {
  id: "thr-lease-1",
  folder: "inbox",
  from: "Jordan Vega",
  email: "jordan@example.com",
  subject: "About the lease",
  preview: "Quick question about move-in.",
  body: "Hi, quick question about move-in.",
  time: "Sep 10, 9:00 AM",
  unread: false,
  recordRef: LEASE_REF,
  messages: [
    { id: "m-out-1", from: "You", body: "Sure, happy to help!", at: "Sep 10, 9:05 AM", outbound: true },
  ],
};

const OTHER_CONTACT_THREAD: FixtureThread = {
  id: "thr-resident-1",
  folder: "inbox",
  from: "Jordan Vega",
  email: "jordan@example.com",
  subject: "About parking",
  preview: "Where can I park?",
  body: "Where can I park?",
  time: "Sep 9, 9:00 AM",
  unread: false,
  recordRef: { kind: "resident", id: "res-9", label: "Jordan Vega" },
};

beforeEach(() => {
  threadRows = [];
  localCacheRows = null;
  syncGate = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecordCommunicationSection", () => {
  it("renders the record's messages and none of the inbox chrome", async () => {
    threadRows = [LEASE_THREAD];
    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        propertyId="prop-1"
        contactIds={["jordan@example.com"]}
      />,
    );

    await screen.findByText("Hi, quick question about move-in.");
    expect(screen.getByText("Sure, happy to help!")).toBeInTheDocument();

    // No inbox chrome: search box, Active/Archived segments, work-number /
    // work-email identity cards, or a conversation list.
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    expect(document.querySelector('[data-attr="communication-segment-active"]')).toBeNull();
    expect(document.querySelector('[data-attr="communication-segment-archived"]')).toBeNull();
    expect(document.querySelector('[data-attr="communication-add-conversation"]')).toBeNull();
    expect(screen.queryByText(/work number/i)).toBeNull();
    expect(screen.queryByText(/work email/i)).toBeNull();
  });

  it("aligns an outbound message to the right", async () => {
    threadRows = [LEASE_THREAD];
    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        contactIds={["jordan@example.com"]}
      />,
    );

    await screen.findByText("Sure, happy to help!");
    await waitFor(() => {
      const end = document.querySelector('[data-inbox-bubble-align="end"]');
      expect(end).not.toBeNull();
      expect(end?.textContent).toContain("Sure, happy to help!");
    });
  });

  it("renders the composer on the empty state", async () => {
    threadRows = [];
    render(
      <RecordCommunicationSection
        role="vendor"
        recordRef={{ kind: "vendor", id: "vendor-1", label: "Acme Plumbing" }}
        contactIds={["vendor@example.com"]}
      />,
    );

    await screen.findByText(/No messages about this vendor yet — write the first one below/i);
    expect(screen.getByPlaceholderText("Write a reply…")).toBeInTheDocument();
  });

  it("merges every conversation with this contact into one timeline, archived included, with no separate link", async () => {
    const ARCHIVED_CONTACT_THREAD: FixtureThread = {
      id: "thr-resident-2",
      folder: "trash",
      from: "Jordan Vega",
      email: "jordan@example.com",
      subject: "About the weekend",
      preview: "Are you around this weekend?",
      body: "Are you around this weekend?",
      time: "Sep 8, 9:00 AM",
      unread: false,
      recordRef: { kind: "resident" as const, id: "res-9", label: "Jordan Vega" },
    };
    threadRows = [LEASE_THREAD, OTHER_CONTACT_THREAD, ARCHIVED_CONTACT_THREAD];
    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        propertyId="prop-1"
        contactIds={["jordan@example.com"]}
      />,
    );

    await screen.findByText("Hi, quick question about move-in.");
    // The other (non-recordRef) conversation with the same contact — and the
    // archived one — merge into this ONE timeline rather than staying behind
    // a separate "N other conversations" link, which no longer exists.
    expect(screen.getByText("Where can I park?")).toBeInTheDocument();
    expect(screen.getByText("Are you around this weekend?")).toBeInTheDocument();
    expect(screen.queryByText(/other conversation/i)).toBeNull();

    cleanup();
    threadRows = [LEASE_THREAD];
    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        propertyId="prop-1"
        contactIds={["jordan@example.com"]}
      />,
    );
    await screen.findByText("Hi, quick question about move-in.");
    expect(screen.queryByText(/other conversation/i)).toBeNull();
  });

  it("offers SMS when contactPhone is set and ensures the record before the first send", async () => {
    threadRows = [];
    const onEnsureRecord = vi.fn(async () => ({
      kind: "vendor" as const,
      id: "vendor-roster-1",
      label: "Northwest Plumbing Co",
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={{ kind: "vendor", id: "axis-catalog-plumbing-nw", label: "Northwest Plumbing Co" }}
        contactIds={["jobs@nwplumbing.example"]}
        contactPhone="(206) 555-0142"
        onEnsureRecord={onEnsureRecord}
      />,
    );

    await screen.findByText(/No messages about this vendor yet/i);
    const channel = screen.getByRole("button", { name: /Send via: Email/i });
    expect(channel).toBeTruthy();
    // Email sits in the tools row beside Send — not a full-width band above the field.
    expect(channel.closest('[data-attr="inbox-composer-tools"]')).not.toBeNull();

    const composer = screen.getByPlaceholderText("Write a reply…");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(composer, { target: { value: "Can you quote a leak?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onEnsureRecord).toHaveBeenCalledOnce());
    await waitFor(() => {
      const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const sendCall = calls.find((call) => String(call[0]).includes("/api/portal/send-inbox-message"));
      expect(sendCall).toBeTruthy();
      const body = JSON.parse(String((sendCall![1] as { body: string }).body));
      expect(body.recordRef).toEqual({
        kind: "vendor",
        id: "vendor-roster-1",
        label: "Northwest Plumbing Co",
      });
    });
  });

  it("never claims 'no messages' before the first server sync lands — a cold local cache is not a real answer", async () => {
    // Reproduces the Night flow F7 race: a reload starts with an EMPTY local
    // cache (`localCacheRows`) even though the server (`threadRows`) genuinely
    // has the thread — the empty state must read as loading, not final, until
    // syncPersistedInboxFromServer's own promise settles.
    localCacheRows = [];
    threadRows = [LEASE_THREAD];
    let releaseSync!: () => void;
    syncGate = new Promise((resolve) => {
      releaseSync = resolve;
    });

    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        propertyId="prop-1"
        contactIds={["jordan@example.com"]}
      />,
    );

    // Mid-race: the local cache is empty and the server sync has not landed
    // yet — must show a loading state, never the confident "no messages" copy.
    await screen.findByText("Loading messages…");
    expect(screen.queryByText(/No messages about this lease yet/i)).toBeNull();

    releaseSync();

    // Once the sync resolves, the real thread renders.
    await screen.findByText("Hi, quick question about move-in.");
    expect(screen.queryByText("Loading messages…")).toBeNull();
  });

  it("shows the honest empty state once the sync has genuinely found nothing", async () => {
    localCacheRows = [];
    threadRows = [];
    render(
      <RecordCommunicationSection
        role="vendor"
        recordRef={{ kind: "vendor", id: "vendor-1", label: "Acme Plumbing" }}
        contactIds={["vendor@example.com"]}
      />,
    );
    await screen.findByText(/No messages about this vendor yet — write the first one below/i);
  });
});
