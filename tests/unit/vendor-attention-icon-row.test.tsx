// @vitest-environment jsdom
//
// QA sweep R15: an icon-action row on Needs attention ("Verify your phone") opens from anywhere on the row, not only its chevron.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AttentionPanel } from "@/components/portal/pro-dashboard-kpis";

describe("Needs attention icon-action row", () => {
  afterEach(cleanup);

  it("links the title to the same place as the chevron, covering the whole row", () => {
    render(
      <AttentionPanel
        rows={[{ id: "messaging", title: "Verify your phone", actionLabel: "Verify phone", iconAction: true, href: "/vendor/profile?tab=messaging", tone: "info" }]}
      />,
    );
    const rowLink = document.querySelector('[data-attr="dashboard-attention-messaging-row-link"]') as HTMLAnchorElement;
    const chevron = document.querySelector('[data-attr="dashboard-attention-messaging-action"]') as HTMLAnchorElement;
    expect(rowLink.getAttribute("href")).toBe("/vendor/profile?tab=messaging");
    expect(chevron.getAttribute("href")).toBe(rowLink.getAttribute("href"));
    // The title's link stretches over the row (after:inset-0 on a relative <li>).
    expect(rowLink.className).toContain("after:absolute");
    expect(rowLink.closest("li")?.className).toContain("relative");
  });

  it("leaves a text-action row's title as plain text", () => {
    render(<AttentionPanel rows={[{ id: "inbox", title: "2 unread messages", actionLabel: "Reply", href: "/vendor/communication/active", tone: "info" }]} />);
    expect(document.querySelector('[data-attr="dashboard-attention-inbox-row-link"]')).toBeNull();
  });
});
