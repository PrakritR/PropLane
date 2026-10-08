// @vitest-environment jsdom
//
// The contact-details column restates what the open conversation already carries.
// It draws a row only for a value that exists, a section only for rows that exist,
// and it lists scheduled sends the thread pane already loaded (no second fetch).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommunicationDetailsPane,
  communicationDetailsFromRow,
} from "@/components/portal/communication-details-pane";
import { InboxThreadView, InboxTwoPane, inboxMessageClock } from "@/components/portal/portal-inbox-ui";
import { usePublishThreadScheduledItems } from "@/components/portal/use-thread-scheduled-cards";
import type { ThreadScheduledItem } from "@/lib/inbox-scheduled-thread";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

afterEach(cleanup);

const SCHEDULED: ThreadScheduledItem = {
  id: "s1",
  source: "manual",
  sendAt: "2026-10-31T16:00:00.000Z",
  sendLabel: "Oct 31, 9:00 AM",
  subject: "Rent reminder",
  body: "Rent is due.",
  editable: true,
  channel: "email",
  deliverViaEmail: true,
  deliverViaSms: false,
};

function Publisher({ email, items }: { email: string; items: ThreadScheduledItem[] }) {
  usePublishThreadScheduledItems(email, items);
  return null;
}

describe("CommunicationDetailsPane", () => {
  it("draws the person, their facts, linked records and the scheduled sends the thread loaded", () => {
    render(
      <>
        <Publisher email="mina@example.com" items={[SCHEDULED]} />
        <CommunicationDetailsPane
          details={{
            name: "Mina Chen",
            role: "Prospect",
            phone: "(206) 555-0199",
            email: "Mina@Example.com",
            records: [{ key: "r1", label: "Tour · 14 Cedar Lane", detail: "14 Cedar Lane", href: "/portal/tours/t1/communication" }],
          }}
        />
      </>,
    );
    expect(screen.getByText("Mina Chen")).toBeTruthy();
    expect(screen.getByText("Prospect")).toBeTruthy();
    expect(screen.getByText("(206) 555-0199")).toBeTruthy();
    expect(screen.getByText("Linked records")).toBeTruthy();
    expect(document.querySelector('[data-attr="communication-details-record"]')?.getAttribute("href")).toBe(
      "/portal/tours/t1/communication",
    );
    expect(document.querySelector('[data-attr="communication-details-scheduled"]')?.textContent).toContain(
      "Rent reminder · Oct 31, 9:00 AM",
    );
  });

  it("draws nothing for what the conversation does not carry", () => {
    render(<CommunicationDetailsPane details={{ name: "Pacific Plumbing", records: [] }} />);
    expect(screen.getByText("Pacific Plumbing")).toBeTruthy();
    expect(screen.queryByText("Phone")).toBeNull();
    expect(screen.queryByText("Email")).toBeNull();
    expect(screen.queryByText("Linked records")).toBeNull();
    expect(screen.queryByText("Scheduled")).toBeNull();
  });

  it("withdraws the scheduled list when the thread pane goes away", () => {
    const { rerender } = render(
      <>
        <Publisher email="mina@example.com" items={[SCHEDULED]} />
        <CommunicationDetailsPane details={{ name: "Mina Chen", email: "mina@example.com", records: [] }} />
      </>,
    );
    expect(screen.getByText("Scheduled")).toBeTruthy();
    act(() => {
      rerender(<CommunicationDetailsPane details={{ name: "Mina Chen", email: "mina@example.com", records: [] }} />);
    });
    expect(screen.queryByText("Scheduled")).toBeNull();
  });

  it("builds details from a list row without inventing a role or a phone", () => {
    const details = communicationDetailsFromRow(
      {
        name: "Jamie Ortiz",
        personEmail: "jamie@example.com",
        address: "61 Willow Court",
        recordRef: { kind: "payment", id: "p1", label: "Rent · October" },
      },
      (kind, id) => `/resident/${kind}/${id}`,
    );
    expect(details).toEqual({
      name: "Jamie Ortiz",
      email: "jamie@example.com",
      records: [{ key: "ref-payment-p1", label: "Rent · October", detail: "61 Willow Court", href: "/resident/payment/p1" }],
    });
    expect(communicationDetailsFromRow(null, () => null)).toBeNull();
  });
});

describe("InboxTwoPane panes=flat", () => {
  // jsdom has no layout: give the surface a width and a ResizeObserver that never fires.
  function surface(width: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const w = this.getAttribute("data-attr") === "portal-inbox-two-pane" ? width : 0;
      return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const mount = () =>
    render(<InboxTwoPane panes="flat" threadOpen list={<div>list</div>} thread={<div>thread</div>} details={<div>details</div>} />);

  it("draws no cards and adds the details column only where the surface itself is 1040px wide", () => {
    surface(1039);
    mount();
    const root = document.querySelector('[data-attr="portal-inbox-two-pane"]') as HTMLElement;
    expect(root.getAttribute("data-panes")).toBe("flat");
    expect(root.className).not.toMatch(/rounded-2xl|shadow/);
    expect(screen.queryByText("details")).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    surface(1040);
    mount();
    expect(screen.getByText("details")).toBeTruthy();
    const aside = document.querySelector('[data-attr="inbox-details-pane"]') as HTMLElement;
    expect(aside.className).not.toMatch(/xl:/);
    const grid = aside.parentElement as HTMLElement;
    expect(grid.className).toContain("grid-cols-[320px_minmax(440px,1fr)_280px]");
  });

  it("two columns at 760px, the thread alone under it", () => {
    surface(760);
    mount();
    const grid = (document.querySelector('[data-attr="portal-inbox-two-pane"]') as HTMLElement).firstElementChild as HTMLElement;
    expect(grid.className).toContain("grid-cols-[320px_minmax(440px,1fr)]");
    expect(grid.className).not.toContain("280px");
    cleanup();
    vi.restoreAllMocks();

    surface(759);
    mount();
    const grid1 = (document.querySelector('[data-attr="portal-inbox-two-pane"]') as HTMLElement).firstElementChild as HTMLElement;
    expect(grid1.className).toContain("grid-cols-1");
    const list = document.querySelector(".portal-inbox-list-pane") as HTMLElement;
    const thread = document.querySelector(".portal-inbox-thread-pane") as HTMLElement;
    expect(list.className.split(/\s+/)).toContain("hidden");
    expect(thread.className.split(/\s+/)).not.toContain("hidden");
  });

  it("opens the same details as a panel over the thread when the column does not fit", () => {
    surface(900);
    render(
      <InboxTwoPane
        panes="flat"
        threadOpen
        list={<div>list</div>}
        thread={<InboxThreadView title="Mina" messages={[]} composer={<textarea aria-label="Reply" />} />}
        details={<div>details</div>}
      />,
    );
    expect(screen.queryByText("details")).toBeNull();
    const info = screen.getByRole("button", { name: "Contact information" });
    fireEvent.click(info);
    expect(screen.getByText("details")).toBeTruthy();
    expect(document.querySelector('[data-attr="inbox-details-panel"]')).toBeTruthy();
    // Esc closes it
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("details")).toBeNull();
    // the info icon toggles it
    fireEvent.click(info);
    expect(screen.getByText("details")).toBeTruthy();
    fireEvent.click(info);
    expect(screen.queryByText("details")).toBeNull();
    // an outside click closes it
    fireEvent.click(info);
    fireEvent.pointerDown(screen.getByText("list"));
    expect(screen.queryByText("details")).toBeNull();
  });
});

describe("inboxMessageClock", () => {
  it("reads the clock out of a canonical stamp without re-parsing it", () => {
    expect(inboxMessageClock("Aug 3, 5:31 PM")).toBe("5:31 PM");
    expect(inboxMessageClock("2:14 PM")).toBe("2:14 PM");
    expect(inboxMessageClock("now")).toBe("now");
  });
});
