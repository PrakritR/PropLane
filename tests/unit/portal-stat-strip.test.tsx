// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";

afterEach(cleanup);

describe("PortalStatStrip", () => {
  it("draws one hairline card per stat: a plain label over the figure, the figure carrying its data-attr", () => {
    const { container } = render(
      <PortalStatStrip
        items={[
          { id: "pending", label: "Pending", value: "$0.00", dataAttr: "stat-pending" },
          { id: "overdue", label: "Overdue", value: "$525.00", dataAttr: "stat-overdue", tone: "danger" },
        ]}
      />,
    );
    const cards = container.querySelectorAll('[data-slot="portal-stat"]');
    expect(cards).toHaveLength(2);
    expect(container.querySelector('[data-attr="stat-overdue"]')?.textContent).toBe("$525.00");
    expect(cards[0]!.className).toContain("border");
    expect(cards[0]!.textContent).toBe("Pending$0.00");
  });
  it("renders nothing for no stats, and a link card when a stat has an href", () => {
    const empty = render(<PortalStatStrip items={[]} />);
    expect(empty.container.firstChild).toBeNull();
    cleanup();
    const { container } = render(<PortalStatStrip items={[{ id: "held", label: "Held deposits", value: "$45", href: "/portal/financials/security-deposits" }]} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/portal/financials/security-deposits");
  });
});
