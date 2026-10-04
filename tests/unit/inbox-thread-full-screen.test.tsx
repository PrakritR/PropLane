// @vitest-environment jsdom
//
// Full-screen conversation: the thread header's Full screen / Exit full screen
// icon, the list stepping aside, Escape, session memory, and the phone rule.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
