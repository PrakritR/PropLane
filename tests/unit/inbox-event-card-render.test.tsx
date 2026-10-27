// @vitest-environment jsdom
//
// A3 (stay chat). The shared thread renderer draws a stamped automated turn as an event card and anything
// else exactly as it always did; a co-host's label sits under the bubble; the owner's own turn has none.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { InboxBubble, InboxMessageTimeline, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { InboxStayCardView } from "@/components/portal/inbox-stay-card";
import { deriveStayCard } from "@/lib/inbox-stay-card";

afterEach(cleanup);

const card: InboxBubbleMessage = {
  id: "ev-1",
  author: "Ambika",
  body: "A new $1,150.00 charge for “Rent” at 4709A was added.",
  at: "Oct 25, 8:46 AM",
  direction: "inbound",
  automated: true,
  eventTitle: "Rent · Payment update",
  eventKind: "charge_created",
  eventCard: { title: "Rent due Nov 1 · $1,150.00", fact: "4709A 8th Ave" },
};

describe("event cards in the thread", () => {
  it("a stamped turn is a card: glyph, bold title, one fact, one action", () => {
    const { container } = render(<InboxBubble message={card} eventViewer="resident" />);
    const el = container.querySelector('[data-inbox-bubble-kind="event"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-inbox-event-kind")).toBe("charge_created");
    expect(el?.querySelector("[data-inbox-event-title]")?.textContent).toBe("Rent due Nov 1 · $1,150.00");
    expect(el?.querySelector("[data-inbox-event-fact]")?.textContent).toBe("4709A 8th Ave");
    const action = el?.querySelector("[data-inbox-event-action]");
    expect(action?.textContent).toBe("Pay");
    expect(action?.getAttribute("href")).toBe("/resident/payments");
    // A card, not a pill or a badge: no rounded-full chip anywhere in it.
    expect(el?.innerHTML).not.toMatch(/rounded-full/);
  });

  it("the manager reads their own move-in announcement as sent, with an Edit link", () => {
    const { container } = render(
      <InboxBubble
        message={{ ...card, eventKind: "move_in_details", eventCard: { title: "Move-in details", fact: "Sun, Nov 1 after 3:00 pm" } }}
        eventViewer="manager"
      />,
    );
    expect(container.querySelector("[data-inbox-event-title]")?.textContent).toBe("Move-in details sent");
    expect(container.querySelector("[data-inbox-event-action]")?.textContent).toBe("Edit");
  });

  it("an old automated turn with no stamp renders exactly the plain activity row it always did", () => {
    const old: InboxBubbleMessage = { ...card, eventKind: undefined, eventCard: undefined };
    const { container } = render(<InboxBubble message={old} eventViewer="resident" />);
    expect(container.querySelector('[data-inbox-bubble-kind="event"]')).toBeNull();
    expect(container.querySelector('[data-inbox-bubble-kind="system"]')).not.toBeNull();
    expect(container.querySelector("[data-inbox-event-title]")).toBeNull();
  });

  it("a kind with no card, or a card with no kind, falls back to the plain row", () => {
    const { container } = render(<InboxBubble message={{ ...card, eventCard: undefined }} />);
    expect(container.querySelector('[data-inbox-bubble-kind="event"]')).toBeNull();
    expect(container.querySelector('[data-inbox-bubble-kind="system"]')).not.toBeNull();
  });

  it("cards and typed messages interleave in one timeline", () => {
    const messages: InboxBubbleMessage[] = [
      card,
      { id: "m-1", author: "Maya", body: "Thanks! Is there a mailbox key?", at: "Oct 25, 9:00 AM", direction: "inbound" },
    ];
    const { container } = render(<InboxMessageTimeline messages={messages} eventViewer="resident" />);
    expect(container.querySelectorAll('[data-inbox-bubble-kind="event"]')).toHaveLength(1);
    expect(container.textContent).toContain("Thanks! Is there a mailbox key?");
  });
});

describe("a co-host's label signs the turn", () => {
  const reply: InboxBubbleMessage = { id: "m-2", author: "Dev", body: "It's on the kitchen hook.", at: "Oct 25, 9:05 AM", direction: "outbound" };

  it("signs the run's header with senderDisplayName when the turn carries one (not 'Property manager')", () => {
    const { container } = render(<InboxBubble message={{ ...reply, author: "Property manager", senderDisplayName: "Dev · Co-host" }} />);
    expect(container.querySelector("[data-inbox-author]")?.textContent).toBe("Dev · Co-host");
    expect(container.querySelector("[data-inbox-sender-display-name]")).toBeNull();
  });

  it("a later turn in a run has no header, so the label sits under the bubble", () => {
    const { container } = render(<InboxBubble cluster="middle" message={{ ...reply, senderDisplayName: "Dev · Co-host" }} />);
    expect(container.querySelector("[data-inbox-sender-display-name]")?.textContent).toBe("Dev · Co-host");
  });

  it("the owner's own turn carries none", () => {
    const { container } = render(<InboxBubble message={{ ...reply, author: "You" }} />);
    expect(container.querySelector("[data-inbox-sender-display-name]")).toBeNull();
  });
});

describe("the stay card", () => {
  it("draws the home placeholder (never a stock photo), title, fact and the viewer's actions", () => {
    const stay = deriveStayCard({
      viewer: "resident",
      leases: [{ id: "l1", homeLabel: "4709A 8th Ave", roomLabel: "Room 3", rentLabel: "$1,150/mo", start: "2026-11-01", end: "2027-04-30", phase: "signed" }],
    })!;
    const { container } = render(<InboxStayCardView card={stay} />);
    expect(container.querySelector("[data-inbox-stay-photo]")).toBeNull();
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    expect(container.querySelector("[data-inbox-stay-title]")?.textContent).toBe("4709A 8th Ave · Room 3");
    expect(container.querySelector("[data-inbox-stay-fact]")?.textContent).toContain("$1,150");
    expect([...container.querySelectorAll("[data-inbox-stay-action]")].map((a) => a.textContent)).toEqual(["Pay", "Lease", "Request service"]);
    expect(container.innerHTML).not.toMatch(/rounded-full/);
  });

  it("a real listing photo replaces the placeholder", () => {
    const stay = deriveStayCard({
      viewer: "manager",
      leases: [{ id: "l1", homeLabel: "4709A", phase: "signed", photoUrl: "https://example.com/a.jpg" }],
    })!;
    const { container } = render(<InboxStayCardView card={stay} />);
    expect(container.querySelector("[data-inbox-stay-photo]")?.getAttribute("src")).toBe("https://example.com/a.jpg");
  });
});
