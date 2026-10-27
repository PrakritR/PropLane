// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the stay chat (studio plan line-206-chat-1026 § A3/A4), rendered for a reviewer screenshot:
// the resident's own thread with the stay card on top, the automated turns drawn as event cards (move-in details,
// room assigned, a new charge) interleaved with typed messages, and a tour host-team thread where a co-host's
// reply is signed with their own first name. Set EVIDENCE_DIR to write the HTML next to the generated app.css.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

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

import { InboxMessageTimeline, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { InboxStayCardView } from "@/components/portal/inbox-stay-card";
import { deriveStayCard } from "@/lib/inbox-stay-card";
import { buildInboxEventStamp, type InboxEventStampInput } from "@/lib/inbox-event-card";

afterEach(cleanup);

/**
 * Every card below is stamped by the SHIPPED builder from the facts an emitter stores, so what the screenshot
 * shows is what a delivery actually carries — not a hand-typed title.
 */
function stamped(message: Omit<InboxBubbleMessage, "eventKind" | "eventCard">, event: InboxEventStampInput): InboxBubbleMessage {
  const stamp = buildInboxEventStamp(event);
  if (!stamp) throw new Error(`no stamp for ${event.domain}/${event.event}`);
  return { ...message, automated: true, eventKind: stamp.kind, eventCard: stamp.card, ...(stamp.recordRef ? { eventRecordRef: stamp.recordRef } : {}) };
}

const RESIDENT_THREAD: InboxBubbleMessage[] = [
  stamped(
    { id: "ev-room", author: "Ambika", body: "You are in Room 3 at 4709A 8th Ave.", at: "Oct 24, 4:12 PM", direction: "inbound", eventTitle: "Room 3 · Room assigned" },
    { domain: "lease", event: "room_assigned", audience: "resident", entityId: "lease-1", payload: { roomLabel: "Room 3", propertyLabel: "4709A 8th Ave", propertyId: "prop-4709a" } },
  ),
  stamped(
    { id: "ev-movein", author: "Ambika", body: "Move-in details for 4709A 8th Ave.", at: "Oct 24, 4:13 PM", direction: "inbound", eventTitle: "Move-in details" },
    { domain: "lease", event: "move_in_details", audience: "resident", entityId: "lease-1", payload: { propertyId: "prop-4709a", propertyLabel: "4709A 8th Ave", cardFact: "Sun, Nov 1 after 3:00 pm · keypad code texted that morning" } },
  ),
  { id: "m-1", author: "Maya", body: "Got it — is there a mailbox key?", at: "Oct 25, 9:00 AM", direction: "inbound" },
  { id: "m-2", author: "Property manager", body: "It's on the kitchen hook, labelled 3.", at: "Oct 25, 9:05 AM", direction: "outbound", senderDisplayName: "Dev · Co-host" },
  stamped(
    { id: "ev-charge", author: "Ambika", body: "A new $1,150.00 charge for “Rent” at 4709A was added.", at: "Oct 25, 8:46 AM", direction: "inbound", eventTitle: "Rent · Payment update" },
    { domain: "payment", event: "charge_created", audience: "resident", entityId: "charge-1", payload: { title: "Rent", amountLabel: "$1,150.00", dueDateLabel: "Nov 1", propertyLabel: "4709A 8th Ave" } },
  ),
];

const TOUR_THREAD: InboxBubbleMessage[] = [
  stamped(
    { id: "ev-tour", author: "Ambika", body: "Your tour of 4709A 8th Ave is confirmed for Sat, Nov 7 at 11:00 am.", at: "Oct 26, 10:02 AM", direction: "inbound", eventTitle: "Tour confirmed" },
    { domain: "tour", event: "tour_confirmed", audience: "resident", entityId: "tour-1", payload: { propertyLabel: "4709A 8th Ave · Room A", cardFact: "Sat, Nov 7 at 11:00 am · 4709A 8th Ave, Room A" } },
  ),
  { id: "t-1", author: "Kumaran", body: "Can I bring my partner to the tour?", at: "Oct 26, 10:20 AM", direction: "inbound" },
  { id: "t-2", author: "Property manager", body: "Of course — see you both Saturday.", at: "Oct 26, 10:24 AM", direction: "outbound", senderDisplayName: "Dev · Co-host" },
];

describe("evidence: the resident's stay chat", () => {
  it("draws the stay card above the thread and every automated turn as an event card", () => {
    const stay = deriveStayCard({
      viewer: "resident",
      leases: [{ id: "l1", homeLabel: "4709A 8th Ave", roomLabel: "Room 3", rentLabel: "$1,150/mo", start: "2026-11-01", end: "2027-04-30", phase: "signed" }],
    })!;
    const { container } = render(
      <div className="flex flex-col gap-3">
        <InboxStayCardView card={stay} />
        <InboxMessageTimeline messages={RESIDENT_THREAD} eventViewer="resident" showAuthors />
      </div>,
    );
    expect(container.querySelector("[data-inbox-stay-title]")?.textContent).toBe("4709A 8th Ave · Room 3");
    expect(container.querySelectorAll('[data-inbox-bubble-kind="event"]')).toHaveLength(3);
    expect([...container.querySelectorAll("[data-inbox-event-title]")].map((t) => t.textContent)).toEqual([
      "Room assigned: Room 3",
      "Move-in details",
      "Rent due Nov 1 · $1,150.00",
    ]);
    expect([...container.querySelectorAll("[data-inbox-event-action]")].map((a) => a.textContent)).toEqual(["Open", "Open", "Pay"]);
    expect([...container.querySelectorAll("[data-inbox-author]")].map((a) => a.textContent)).toContain("Dev · Co-host");
    writeEvidenceSurface(
      "30-stay-chat-resident",
      "Resident Communication: the stay card (home placeholder, room, rent, dates) over one thread where room assigned / move-in details / the new Rent charge are event cards with one action each, interleaved with typed messages — and the co-host's reply signed Dev · Co-host.",
    );
  });

  it("the manager reads their own move-in announcement as sent, with Edit", () => {
    const { container } = render(<InboxMessageTimeline messages={RESIDENT_THREAD} eventViewer="manager" showAuthors />);
    expect([...container.querySelectorAll("[data-inbox-event-title]")].map((t) => t.textContent)).toContain("Move-in details sent");
    expect([...container.querySelectorAll("[data-inbox-event-action]")].map((a) => a.textContent)).toEqual(["View", "Edit", "View"]);
    writeEvidenceSurface("31-stay-chat-manager", "The same thread in the manager's Communication: 'Move-in details sent' with Edit, and the charge card's action is View, not Pay.");
  });

  it("a tour is one host-team thread the co-host answers as themselves", () => {
    const { container } = render(<InboxMessageTimeline messages={TOUR_THREAD} eventViewer="resident" showAuthors />);
    expect(container.querySelector("[data-inbox-event-title]")?.textContent).toBe("Tour confirmed");
    expect([...container.querySelectorAll("[data-inbox-author]")].map((a) => a.textContent)).toContain("Dev · Co-host");
    writeEvidenceSurface(
      "32-tour-host-team-thread",
      "A tour request as one host-team thread in the owner's conversation: the confirmation is an event card stamped with the house, and the co-host's reply reaches the prospect signed with their own first name.",
    );
  });
});
