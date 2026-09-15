// @vitest-environment jsdom
/**
 * The one empty card (PLAN-0914-1629): glyph tile · title · sibling link ·
 * pill. No sentence under the title. Muted tone for "no matches" with a Clear
 * link and no pill; a disabled pill keeps its reason as the tooltip.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";

vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => null }));

describe("PortalListEmptyCard", () => {
  it("draws tile, title, sibling and pill — and nothing under the title", () => {
    const onAdd = vi.fn();
    const { container } = render(
      <PortalListEmptyCard
        section="properties"
        title="Nothing unlisted"
        description="This sentence must not render"
        sibling={{ label: "1 listed", href: "/portal/properties/listed" }}
        actions={[{ label: "Add property", onClick: onAdd, dataAttr: "x-add" }]}
      />,
    );
    expect(container.querySelector('[data-slot="portal-list-empty-tile"] svg')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Nothing unlisted" })).toBeTruthy();
    expect(container.textContent).not.toContain("This sentence must not render");
    expect(screen.getByRole("link", { name: /1 listed/ }).getAttribute("href")).toBe("/portal/properties/listed");
    fireEvent.click(screen.getByRole("button", { name: /Add property/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    // an "Add …" pill carries a plus
    expect(screen.getByRole("button", { name: /Add property/ }).querySelector("svg")).not.toBeNull();
  });

  it("muted no-match: grey tile, a Clear link, no pill even when actions are passed", () => {
    const onClear = vi.fn();
    const { container } = render(
      <PortalListEmptyCard
        section="tours"
        tone="muted"
        title="No tours match these filters"
        clear={{ label: "Clear filters", onClick: onClear }}
        actions={[{ label: "Schedule tour", onClick: () => {} }]}
      />,
    );
    expect(container.querySelector('[data-attr="portal-list-empty-card"]')?.getAttribute("data-tone")).toBe("muted");
    expect(screen.queryByRole("button", { name: /Schedule tour/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("a disabled pill says why in its tooltip", () => {
    render(
      <PortalListEmptyCard
        section="tours"
        title="No tours pending"
        actions={[{ label: "Schedule tour", disabled: true, reason: "List a property first — tours are booked against a listing." }]}
      />,
    );
    const pill = screen.getByRole("button", { name: /Schedule tour/ });
    expect(pill).toBeDisabled();
    expect(pill.getAttribute("title")).toContain("List a property first");
  });

  it("a local-state sibling renders as a button", () => {
    const onSelect = vi.fn();
    render(<PortalListEmptyCard section="services" title="No open services" sibling={{ label: "2 scheduled", onClick: onSelect }} />);
    fireEvent.click(screen.getByRole("button", { name: /2 scheduled/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
