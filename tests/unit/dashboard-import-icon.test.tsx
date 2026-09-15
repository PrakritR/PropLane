// @vitest-environment jsdom
/**
 * Dashboard "Your properties" header carries an Import portfolio icon next to
 * the existing Add property action — a real link, not a click handler, so it
 * works the same way every other header icon does.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortfolioPropertiesSection } from "@/components/portal/pro-dashboard-portfolio";

describe("dashboard Import portfolio icon", () => {
  it("renders with the accessible name and the import route as its href", () => {
    render(<PortfolioPropertiesSection cards={[]} basePath="/portal" addPropertyAction={null} />);
    const link = screen.getByRole("link", { name: "Import portfolio" });
    expect(link.getAttribute("href")).toBe("/portal/properties/import");
    expect(link.getAttribute("data-attr")).toBe("dashboard-import-portfolio");
    expect(link.querySelector("svg")).not.toBeNull();
  });
});
