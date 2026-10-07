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
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/components/portal/pro-sms-compose-modal", () => ({
  ManagerSmsComposeModal: () => null,
}));

import { ManagerSmsPanel } from "@/components/portal/pro-sms-panel";

afterEach(cleanup);

const LONG_URL_BODY =
  "Thanks for the question for 5259 Brooklyn Ave NE. I'm pulling the details and the manager has been notified. You can also leave more detail here: https://prop-lane.space/rent/tours-contact?property=5259-brooklyn-ave-ne-seattle";

describe("inbox message rows (Slack-style: every turn on the left, the name says who)", () => {
  it("marks the viewer's own turn end-side and a counterparty's start-side, both flush left", () => {
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
    const mine = document.querySelector('[data-inbox-bubble-align="end"]');
    expect(mine?.className).toMatch(/min-w-0/);
    expect(mine?.className).not.toMatch(/ml-auto|mr-auto/);
    expect(mine?.textContent).toContain("You");

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
    const theirs = document.querySelector('[data-inbox-bubble-align="start"]');
    expect(theirs?.className).not.toMatch(/ml-auto|mr-auto/);
    expect(theirs?.textContent).toContain("Akhil");
  });

  it("renders an auto-sent lifecycle turn as a centered system notice, not a message row", () => {
    render(
      <InboxBubble
        message={{
          id: "sys",
          author: "Akhil",
          body: "Lease sent for signature.",
          at: "2:14 PM",
          direction: "system",
        }}
      />,
    );
    const notice = document.querySelector('[data-inbox-bubble-kind="system"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain("Lease sent for signature.");
    // Never a message row — no aligned wrap, no author, no sending/failed chrome.
    expect(document.querySelector('[data-inbox-bubble-align]')).toBeNull();
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
    for (const el of [...ends, ...starts]) expect(el.className).toMatch(/min-w-0/);
    // Four turns, four senders' runs: each run names its sender once.
    expect([...document.querySelectorAll("[data-inbox-author]")].map((el) => el.textContent)).toEqual([
      "Akhil",
      "You",
      "Akhil",
      "You",
    ]);
  });

  it("names a run's sender once, then shows only the text for the turns that follow", () => {
    render(
      <InboxMessageTimeline
        messages={[
          { id: "a", author: "Akhil", body: "First", at: "Aug 3, 5:31 PM", direction: "inbound" },
          { id: "b", author: "Akhil", body: "Second", at: "Aug 3, 5:32 PM", direction: "inbound" },
        ]}
      />,
    );
    expect(document.querySelectorAll("[data-inbox-author]")).toHaveLength(1);
    expect(screen.getByText("5:31 PM")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("shows the assistant's turns without an Assistant label, in the PropLane Assistant conversation", () => {
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
      expect(el.getAttribute("data-inbox-bubble-align")).toBe("start");
      expect(el.textContent).not.toMatch(/Assistant/i);
      expect(el.textContent).toMatch(/2:14 PM/);
    }
    expect(you[0]?.getAttribute("data-inbox-bubble-align")).toBe("end");
    expect(you[0]?.textContent).toContain("Jordan");
  });

  it("keeps assistant-authored reminders on the viewer's side in a person thread", () => {
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
    expect(ice?.getAttribute("data-inbox-bubble-align")).toBe("end");
  });

  it("renders assistant markdown as formatted headings and lists", () => {
    const { container } = render(
      <InboxBubble
        message={{
          id: "assistant-overview",
          author: "PropLane Assistant",
          body: "Here's what I can help with:\n\n**Your Portfolio**\n- Check property listings\n- Review rental applications",
          at: "2:14 PM",
          direction: "assistant",
        }}
      />,
    );

    expect(screen.getByText("Your Portfolio").tagName).toBe("STRONG");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });
});

describe("inbox bubble channel tag and subject line", () => {
  it("shows the stamped channel, never a guessed Email for an unstamped turn", () => {
    const messages: InboxBubbleMessage[] = [
      { id: "1", author: "Dana", body: "a", at: "1:17 PM", direction: "inbound", channel: "email" },
      { id: "2", author: "You", body: "hey", at: "1:20 PM", direction: "outbound", channel: "proplane" },
    ];
    render(<InboxMessageTimeline messages={messages} />);
    const tags = () => Array.from(document.querySelectorAll("span")).map((el) => el.textContent?.trim());
    expect(tags()).toContain("Email");
    expect(tags()).toContain("In-app");
    cleanup();

    // An unstamped legacy turn used to wear "Email" by default — the tag that
    // made an in-app reply look like it had been emailed.
    render(
      <InboxMessageTimeline
        messages={[{ id: "3", author: "You", body: "legacy", at: "1:21 PM", direction: "outbound" }]}
      />,
    );
    expect(tags()).not.toContain("Email");
    expect(tags()).not.toContain("In-app");
  });

  it("renders the email subject as the bubble's first line only when the builder set it", () => {
    render(
      <InboxBubble
        message={{
          id: "in",
          author: "Dana",
          body: "a",
          at: "1:17 PM",
          direction: "inbound",
          channel: "email",
          subject: "Re: Propert",
        }}
      />,
    );
    expect(document.querySelector("[data-inbox-bubble-subject]")?.textContent).toBe("Re: Propert");
    cleanup();
    render(
      <InboxBubble
        message={{ id: "in2", author: "Dana", body: "a", at: "1:17 PM", direction: "inbound", channel: "email" }}
      />,
    );
    expect(document.querySelector("[data-inbox-bubble-subject]")).toBeNull();
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

  it("marks the manager's own texts end-side and the prospect's start-side, all flush left, even with long URLs", async () => {
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
    for (const text of [...outbound, ...inbound]) {
      // Slack-style: no filled bubble, no side-pinning margin; the name says who sent it.
      expect(text.className).not.toMatch(/portal-inbox-outbound-bubble/);
      expect(text.parentElement?.className).not.toMatch(/ml-auto|mr-auto/);
      expect(text.parentElement?.className).toMatch(/min-w-0/);
    }
    expect(document.querySelectorAll("[data-inbox-author]").length).toBeGreaterThanOrEqual(4);
    expect(document.querySelector('[data-inbox-via="sms"]')?.textContent).toContain("Text");
  });
});
