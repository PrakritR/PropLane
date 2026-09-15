// @vitest-environment jsdom
/**
 * List chrome is icons only (PLAN-0914-1345): the word is the accessible name
 * and the tooltip, never visible text, at every width. The page's one primary
 * action is the filled circle and still announces its job by name.
 */
import { render, screen } from "@testing-library/react";
import { SlidersHorizontal, Link2 } from "lucide-react";
import { describe, expect, it } from "vitest";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";

describe("PortalIconAction", () => {
  it("draws no visible word — the label is the accessible name and the tooltip", () => {
    render(<PortalIconAction icon={SlidersHorizontal} label="Filter" />);
    const button = screen.getByRole("button", { name: "Filter" });
    expect(button.getAttribute("title")).toBe("Filter");
    expect(button.textContent?.trim()).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("keeps a full label like 'Filter · 2 active' as the name", () => {
    render(<PortalIconAction icon={SlidersHorizontal} label="Filter · 2 active" active badge={2} />);
    const button = screen.getByRole("button", { name: "Filter · 2 active" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const badge = button.querySelector('[data-slot="portal-icon-badge"]');
    expect(badge?.textContent).toBe("2");
  });

  it("marks an open setup step with the amber dot", () => {
    render(<PortalIconAction icon={SlidersHorizontal} label="Payment setup" badge="warn" />);
    const badge = screen.getByRole("button", { name: "Payment setup" }).querySelector('[data-slot="portal-icon-badge"]');
    expect(badge?.getAttribute("data-tone")).toBe("warn");
  });

  it("draws no badge for zero or nothing", () => {
    const { container } = render(
      <>
        <PortalIconAction icon={SlidersHorizontal} label="A" badge={0} />
        <PortalIconAction icon={SlidersHorizontal} label="B" />
      </>,
    );
    expect(container.querySelectorAll('[data-slot="portal-icon-badge"]')).toHaveLength(0);
  });
});

describe("PortalPrimaryIconAction", () => {
  it("is a plus by default and carries the job in its name, not as text", () => {
    render(<PortalPrimaryIconAction label="Add property" data-attr="manager-properties-add-top" />);
    const button = screen.getByRole("button", { name: "Add property" });
    expect(button.textContent?.trim()).toBe("");
    expect(button.getAttribute("data-slot")).toBe("portal-primary-icon-action");
    expect(button.getAttribute("data-attr")).toBe("manager-properties-add-top");
  });

  it("takes another glyph for a section whose primary is not 'add'", () => {
    render(<PortalPrimaryIconAction label="Link Airbnb" icon={Link2} disabled />);
    const button = screen.getByRole("button", { name: "Link Airbnb" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg.lucide-link-2, svg.lucide-link2")).not.toBeNull();
  });
});
