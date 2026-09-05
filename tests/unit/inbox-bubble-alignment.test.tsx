// @vitest-environment jsdom
//
// Long outbound bodies (especially URLs) used to expand the flex item to full
// width via min-width:auto, so blue "sent" bubbles sat on the left next to
// grey inbound ones. Alignment must stay side-pinned regardless of body length.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  InboxBubble,
  InboxMessageTimeline,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";

afterEach(cleanup);

const LONG_URL_BODY =
  "Thanks for the question for 5259 Brooklyn Ave NE. I'm pulling the details and the manager has been notified. You can also leave more detail here: https://prop-lane.space/rent/tours-contact?property=5259-brooklyn-ave-ne-seattle";

describe("inbox bubble alignment", () => {
  it("pins outbound InboxBubble to the end and inbound to the start", () => {
    const { rerender } = render(
      <InboxBubble
        message={{
          id: "out",
          author: "You",
          body: LONG_URL_BODY,
          at: "now",
          direction: "outbound",
        }}
      />,
    );
    expect(document.querySelector('[data-inbox-bubble-align="end"]')?.className).toMatch(/ml-auto/);
    expect(document.querySelector('[data-inbox-bubble-align="end"]')?.className).toMatch(/min-w-0/);

    rerender(
      <InboxBubble
        message={{
          id: "in",
          author: "Akhil",
          body: "Hello this is akhil",
          at: "now",
          direction: "inbound",
        }}
      />,
    );
    expect(document.querySelector('[data-inbox-bubble-align="start"]')?.className).toMatch(/mr-auto/);
  });

  it("keeps mixed timeline sides correct when an outbound body has a long URL", () => {
    const messages: InboxBubbleMessage[] = [
      { id: "1", author: "Akhil", body: "Hello this is akhil", at: "1", direction: "inbound" },
      {
        id: "2",
        author: "You",
        body: "Hey Akhil! Welcome. Are you looking to tour?",
        at: "2",
        direction: "outbound",
      },
      {
        id: "3",
        author: "Akhil",
        body: "I want to see the available listings",
        at: "3",
        direction: "inbound",
      },
      { id: "4", author: "You", body: LONG_URL_BODY, at: "4", direction: "outbound" },
    ];
    render(<InboxMessageTimeline messages={messages} />);
    const ends = [...document.querySelectorAll('[data-inbox-bubble-align="end"]')];
    const starts = [...document.querySelectorAll('[data-inbox-bubble-align="start"]')];
    expect(ends).toHaveLength(2);
    expect(starts).toHaveLength(2);
    for (const el of ends) expect(el.className).toMatch(/ml-auto/);
    for (const el of starts) expect(el.className).toMatch(/mr-auto/);
  });

  it("pins assistant ice bubbles left in the PropLane Assistant conversation", () => {
    const messages: InboxBubbleMessage[] = [
      {
        id: "intro",
        author: "PropLane Assistant",
        body: "Hi - you can ask me about your lease.",
        at: "2:14 PM",
        direction: "assistant",
      },
      {
        id: "ask",
        author: "Jordan",
        body: "What is my rent this month?",
        at: "2:14 PM",
        direction: "outbound",
      },
      {
        id: "answer",
        author: "PropLane Assistant",
        body: "Rent is due on the 1st. Let me know if you want a receipt.",
        at: "2:14 PM",
        direction: "assistant",
      },
    ];
    render(<InboxMessageTimeline messages={messages} showAuthors alignAssistantStart />);
    const ice = [...document.querySelectorAll('[data-inbox-bubble-kind="assistant"]')];
    const you = [...document.querySelectorAll('[data-inbox-bubble-kind="outbound"]')];
    expect(ice).toHaveLength(2);
    expect(you).toHaveLength(1);
    for (const el of ice) {
      expect(el.className).toMatch(/mr-auto/);
      expect(el.querySelector(".portal-inbox-assistant-bubble")).toBeTruthy();
      expect(el.textContent).not.toMatch(/Assistant/i);
      expect(el.textContent).toMatch(/2:14 PM/);
    }
    expect(you[0]?.className).toMatch(/ml-auto/);
    expect(you[0]?.querySelector(".portal-inbox-outbound-bubble")).toBeTruthy();
  });

  it("keeps assistant-authored reminders right in a person thread", () => {
    render(
      <InboxMessageTimeline
        messages={[
          {
            id: "reminder",
            author: "PropLane Assistant",
            body: "Your rent is overdue.",
            at: "2:14 PM",
            direction: "assistant",
          },
        ]}
      />,
    );
    const ice = document.querySelector('[data-inbox-bubble-kind="assistant"]');
    expect(ice?.className).toMatch(/ml-auto/);
  });
});

describe("manager SMS bubble alignment", () => {
  const PAYLOAD = {
    workNumber: "+12065550999",
    personalPhone: null,
    phoneVerified: false,
    forwardInbound: true,
    smsConfigured: true,
    residents: [
      {
        residentUserId: null,
        residentEmail: null,
        name: "Akhil Vemuri",
        phone: "+15106489423",
        propertyLabel: null,
        tenancyStatus: "unknown" as const,
        counterpartyRole: "prospect" as const,
        conversationKey: "mgr-1:prospect:phone:+15106489423",
        ownerManagerUserId: "mgr-1",
        messages: [
          {
            id: "m-in-1",
            direction: "inbound" as const,
            body: "Hello this is akhil",
            fromPhone: "+15106489423",
            toPhone: "+12065550999",
            messageSid: "SM1",
            source: "work_number" as const,
            createdAt: "2026-08-26T19:00:00.000Z",
            storageTable: "inbound_sms_log" as const,
          },
          {
            id: "m-out-1",
            direction: "outbound" as const,
            body: "Hey Akhil! Welcome. Are you looking to tour?",
            fromPhone: "+12065550999",
            toPhone: "+15106489423",
            messageSid: "SM2",
            source: "work_number" as const,
            createdAt: "2026-08-26T19:01:00.000Z",
            storageTable: "manager_sms_messages" as const,
          },
          {
            id: "m-in-2",
            direction: "inbound" as const,
            body: "I want to see the available listings, which manager is this number tied to?",
            fromPhone: "+15106489423",
            toPhone: "+12065550999",
            messageSid: "SM3",
            source: "work_number" as const,
            createdAt: "2026-08-26T19:02:00.000Z",
            storageTable: "inbound_sms_log" as const,
          },
          {
            id: "m-out-2",
            direction: "outbound" as const,
            body: LONG_URL_BODY,
            fromPhone: "+12065550999",
            toPhone: "+15106489423",
            messageSid: "SM4",
            source: "work_number" as const,
            createdAt: "2026-08-26T19:03:00.000Z",
            storageTable: "manager_sms_messages" as const,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key of Object.keys(store)) delete store[key];
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => PAYLOAD,
      })),
    );
  });

  it("keeps manager/AI outbound SMS bubbles on the right even with long URLs", async () => {
    render(
      <ManagerSmsPanel
        suppressListPane
        controlledActiveId="mgr-1:prospect:phone:+15106489423"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Thanks for the question for 5259 Brooklyn/)).toBeTruthy();
    });
    const outbound = [...document.querySelectorAll('[data-sms-bubble-align="end"]')];
    const inbound = [...document.querySelectorAll('[data-sms-bubble-align="start"]')];
    expect(outbound.length).toBeGreaterThanOrEqual(2);
    expect(inbound.length).toBeGreaterThanOrEqual(2);
    for (const bubble of outbound) {
      expect(bubble.className).toMatch(/portal-inbox-outbound-bubble/);
      const row = bubble.parentElement;
      expect(row?.className).toMatch(/ml-auto/);
      expect(row?.className).toMatch(/min-w-0/);
    }
    for (const bubble of inbound) {
      expect(bubble.className).not.toMatch(/portal-inbox-outbound-bubble/);
      expect(bubble.parentElement?.className).toMatch(/mr-auto/);
    }
  });
});
