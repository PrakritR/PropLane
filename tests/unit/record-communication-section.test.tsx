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

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadPersistedInbox: (_key: string, fallback: unknown[]) => threadRows ?? fallback,
    syncPersistedInboxFromServer: async () => threadRows,
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

  it("shows the other-conversations link only when other threads with this contact exist", async () => {
    threadRows = [LEASE_THREAD, OTHER_CONTACT_THREAD];
    render(
      <RecordCommunicationSection
        role="manager"
        recordRef={LEASE_REF}
        propertyId="prop-1"
        contactIds={["jordan@example.com"]}
      />,
    );

    const link = await screen.findByText(/1 other conversation with this contact/i);
    expect(link.closest("a")).toHaveAttribute("href", "/portal/communication");

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
});
