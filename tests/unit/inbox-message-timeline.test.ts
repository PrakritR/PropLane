import { describe, expect, it } from "vitest";
import { buildInboxMessageTimeline } from "@/lib/inbox-message-timeline";
import type { InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";

describe("buildInboxMessageTimeline", () => {
  it("clusters consecutive outbound messages", () => {
    const messages: InboxBubbleMessage[] = [
      { id: "1", author: "You", body: "one", at: "9:00", direction: "outbound" },
      { id: "2", author: "You", body: "two", at: "9:01", direction: "outbound" },
      { id: "3", author: "Them", body: "reply", at: "9:02", direction: "inbound" },
    ];
    const items = buildInboxMessageTimeline(messages);
    expect(items).toHaveLength(3);
    expect(items[0]?.cluster).toBe("first");
    expect(items[0]?.showMeta).toBe(false);
    expect(items[1]?.cluster).toBe("last");
    expect(items[1]?.showMeta).toBe(true);
    expect(items[2]?.cluster).toBe("single");
  });

  it("creates distinct rendered keys when malformed input repeats a message id", () => {
    const items = buildInboxMessageTimeline([
      { id: "merged:tour-root", author: "PropLane Tours", body: "Received", at: "9:00", direction: "inbound" },
      { id: "merged:tour-root", author: "PropLane Tours", body: "Confirmed", at: "9:01", direction: "inbound" },
    ]);

    expect(items.map((item) => item.key)).toEqual(["merged:tour-root", "merged:tour-root#2"]);
  });
});
