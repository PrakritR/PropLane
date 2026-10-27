// @vitest-environment jsdom
//
// Full-screen conversation: the thread header's Full screen / Exit full screen
// icon, the list stepping aside, Escape, session memory, and the phone rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InboxThreadView, InboxTwoPane } from "@/components/portal/portal-inbox-ui";
import {
  INBOX_FULL_SCREEN_BUTTON_CLASS,
  INBOX_FULL_SCREEN_STORAGE_KEY,
  inboxFullScreenActive,
  inboxFullScreenLabel,
  resetInboxFullScreenForTests,
  setInboxFullScreen,
} from "@/lib/inbox-full-screen";

const messages = [
  { id: "m1", author: "PropLane Assistant", body: "Hello", at: "9:00 AM", direction: "inbound" as const },
];

function Harness({ threadOpen = true, threadKey = "a" }: { threadOpen?: boolean; threadKey?: string }) {
  return (
    <InboxTwoPane
      panes="split"
      threadOpen={threadOpen}
      list={<div data-testid="list">conversations</div>}
      thread={
        <InboxThreadView
          title="PropLane Assistant"
          messages={messages}
          threadKey={threadKey}
          composer={<textarea aria-label="Reply" rows={1} />}
        />
      }
    />
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetInboxFullScreenForTests();
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
});
afterEach(() => cleanup());

describe("inbox full screen", () => {
  it("pure logic: label flips, narrow viewports never draw it", () => {
    expect(inboxFullScreenLabel(false)).toBe("Full screen");
    expect(inboxFullScreenLabel(true)).toBe("Exit full screen");
    expect(inboxFullScreenActive({ fullScreen: true, threadOpen: true, viewportWidth: 1440 })).toBe(true);
    expect(inboxFullScreenActive({ fullScreen: true, threadOpen: true, viewportWidth: 390 })).toBe(false);
    expect(inboxFullScreenActive({ fullScreen: true, threadOpen: false, viewportWidth: 1440 })).toBe(false);
    expect(INBOX_FULL_SCREEN_BUTTON_CLASS).toBe("hidden lg:inline-flex");
  });

  it("button is hidden below lg and carries the label", () => {
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "Full screen" });
    expect(btn.className).toContain("hidden");
    expect(btn.className).toContain("lg:inline-flex");
  });

  it("toggle hides the list, pins the thread, and flips the label", () => {
    const { container } = render(<Harness />);
    const list = container.querySelector(".portal-inbox-list-pane")!;
    expect(list.className).toContain("lg:flex");
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(list.className).not.toContain("lg:flex");
    expect(list.className).toMatch(/(^| )hidden( |$)/);
    const root = container.querySelector<HTMLElement>(".portal-inbox-two-pane")!;
    expect(root.dataset.fullScreen).toBe("true");
    expect(root.style.position).toBe("fixed");
    expect(container.querySelector(".grid")!.className).toContain("grid-cols-1");
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
    expect(screen.getByLabelText("Reply")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(root.dataset.fullScreen).toBeUndefined();
    expect(list.className).toContain("lg:flex");
  });

  it("Escape exits", () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(container.querySelector<HTMLElement>(".portal-inbox-two-pane")!.dataset.fullScreen).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector<HTMLElement>(".portal-inbox-two-pane")!.dataset.fullScreen).toBeUndefined();
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
  });

  it("switching conversation keeps it; closing the thread exits it", () => {
    const { container, rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    rerender(<Harness threadKey="b" />);
    expect(container.querySelector<HTMLElement>(".portal-inbox-two-pane")!.dataset.fullScreen).toBe("true");
    rerender(<Harness threadOpen={false} />);
    expect(window.sessionStorage.getItem(INBOX_FULL_SCREEN_STORAGE_KEY)).toBeNull();
    rerender(<Harness threadOpen />);
    expect(container.querySelector<HTMLElement>(".portal-inbox-two-pane")!.dataset.fullScreen).toBeUndefined();
  });

  it("is never drawn on a phone-width viewport even if remembered", () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true, writable: true });
    act(() => setInboxFullScreen(true));
    const { container } = render(<Harness />);
    expect(container.querySelector<HTMLElement>(".portal-inbox-two-pane")!.dataset.fullScreen).toBeUndefined();
  });

  it("an embedded thread (no split pane) has no full-screen button", () => {
    render(<InboxThreadView title="x" messages={messages} headerActions={<span>a</span>} />);
    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
  });
});

/**
 * Communication is two columns (list + conversation) at every width from 760px; the contact details open on
 * demand from the thread header's info icon; and full screen fills the content area exactly (no `-mx-8` bleed
 * that slid the pinned pane 32px left under the sidebar) with the conversation centred at 760px.
 */
function FlatHarness({ details = true }: { details?: boolean }) {
  return (
    <InboxTwoPane
      panes="flat"
      threadOpen
      details={details ? <div data-testid="details">Contact details</div> : undefined}
      list={<div data-testid="list">conversations</div>}
      thread={
        <InboxThreadView
          title="Aarav Jain"
          messages={messages}
          threadKey="a"
          composer={<textarea aria-label="Reply" rows={1} />}
        />
      }
    />
  );
}

function surfaceWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.classList?.contains("portal-inbox-two-pane") ? width : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 0, width: w, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe("inbox sizing: two columns, details on demand, centred full screen", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([1040, 1280, 1600])("draws two columns at %ipx, never a third details column", (width) => {
    surfaceWidth(width);
    const { container } = render(<FlatHarness />);
    expect(container.querySelector('[data-attr="inbox-details-pane"]')).toBeNull();
    expect(container.querySelector(".grid")!.className).toContain("grid-cols-[320px_minmax(440px,1fr)]");
    expect(container.querySelector(".grid")!.className).not.toContain("280px");
    expect(screen.getByTestId("list")).toBeTruthy();
    expect(screen.queryByTestId("details")).toBeNull();
  });

  it("the info icon in the thread header opens the contact details as the 280px panel, and closes it", () => {
    surfaceWidth(1600);
    const { container } = render(<FlatHarness />);
    const info = screen.getByRole("button", { name: "Contact information" });
    expect(info.getAttribute("data-slot")).toBe("portal-icon-action");
    expect(container.querySelector('[data-attr="inbox-details-panel"]')).toBeNull();
    fireEvent.click(info);
    const panel = container.querySelector('[data-attr="inbox-details-panel"]')!;
    expect(panel.className).toContain("w-[280px]");
    expect(screen.getByTestId("details")).toBeTruthy();
    fireEvent.click(info);
    expect(container.querySelector('[data-attr="inbox-details-panel"]')).toBeNull();
  });

  it("a thread with no contact details has no info icon", () => {
    surfaceWidth(1600);
    render(<FlatHarness details={false} />);
    expect(screen.queryByRole("button", { name: "Contact information" })).toBeNull();
  });

  it("full screen drops the -mx-8 bleed and centres the body and composer at 760px", () => {
    surfaceWidth(1600);
    const { container } = render(<FlatHarness />);
    const root = container.querySelector<HTMLElement>(".portal-inbox-two-pane")!;
    expect(root.className).toContain("lg:-mx-8");
    expect(container.querySelector('[data-attr="inbox-thread-centred"]')).toBeNull();
    const reply = screen.getByLabelText("Reply");

    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(root.dataset.fullScreen).toBe("true");
    expect(root.style.position).toBe("fixed");
    expect(root.className).not.toContain("-mx-8");
    const centred = container.querySelector('[data-attr="inbox-thread-centred"]')!;
    expect(centred.className).toContain("mx-auto");
    expect(centred.className).toContain("max-w-[760px]");
    expect(centred.className).toContain("w-full");
    expect(centred.contains(screen.getByLabelText("Reply"))).toBe(true);
    expect(centred.querySelector(".portal-inbox-thread-body")).not.toBeNull();
    // The header stays edge to edge, outside the centred column.
    expect(centred.querySelector(".portal-inbox-thread-header")).toBeNull();
    // Entering full screen never remounts the composer, so a typed draft survives.
    expect(screen.getByLabelText("Reply")).toBe(reply);

    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(root.className).toContain("lg:-mx-8");
    expect(container.querySelector('[data-attr="inbox-thread-centred"]')).toBeNull();
    expect(screen.getByLabelText("Reply")).toBe(reply);
  });

  it("the details panel is still reachable in full screen", () => {
    surfaceWidth(1600);
    const { container } = render(<FlatHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Contact information" }));
    expect(container.querySelector('[data-attr="inbox-details-panel"]')).not.toBeNull();
  });
});
