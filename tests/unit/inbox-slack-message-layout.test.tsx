// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { InboxBubble, InboxMessageTimeline, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";

afterEach(() => cleanup());

const messages: InboxBubbleMessage[] = [
  { id: "1", direction: "inbound", author: "Jordan Rivera", body: "Is the room still open?", at: "2026-10-05T17:00:00.000Z" },
  { id: "2", direction: "inbound", author: "Jordan Rivera", body: "Also, parking?", at: "2026-10-05T17:01:00.000Z" },
  { id: "3", direction: "outbound", author: "Alex Manager", body: "Yes, tour Sunday.", at: "2026-10-05T17:05:00.000Z" },
] as InboxBubbleMessage[];

describe("record Communication, Slack-style message rows", () => {
  it("draws a message row with a 32px avatar tile, a 14px/650 name, a 12px grey time and 14px text", () => {
    const { container } = render(<InboxBubble message={messages[0]!} layout="slack" cluster="single" />);
    const row = container.querySelector('[data-inbox-message-layout="slack"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".size-8")).not.toBeNull();
    const name = row.querySelector("span.font-\\[650\\]");
    expect(name?.textContent).toBe("Jordan Rivera");
    expect(name?.className).toContain("text-[14px]");
    expect(row.querySelector("span.text-\\[12px\\]")).not.toBeNull();
    expect(row.querySelector("p.text-\\[14px\\]")?.textContent).toBe("Is the room still open?");
    // No chat bubble chrome.
    expect(container.querySelector(".portal-inbox-inbound-bubble")).toBeNull();
  });

  it("names the author once per run: a second consecutive message has no name line", () => {
    const { container } = render(<InboxMessageTimeline messages={messages} layout="slack" />);
    const rows = Array.from(container.querySelectorAll('[data-inbox-message-layout="slack"]'));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Jordan Rivera");
    expect(rows[1]!.textContent).not.toContain("Jordan Rivera");
    expect(rows[2]!.textContent).toContain("Alex Manager");
  });

  it("keeps chat bubbles by default", () => {
    const { container } = render(<InboxMessageTimeline messages={messages} />);
    expect(container.querySelector('[data-inbox-message-layout="slack"]')).toBeNull();
    expect(container.querySelector(".portal-inbox-inbound-bubble")).not.toBeNull();
  });
});
