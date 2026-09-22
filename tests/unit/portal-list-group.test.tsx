// @vitest-environment jsdom
/**
 * `PortalListGroup` (PLAN-0921-1029 "Grouping & sort") is ONE container: the
 * header at the top, its rows inside it separated by hairlines, and the
 * group's footer at the bottom — never a card per header plus a floating
 * card per row. `PortalListGroupRowContext` (`usePortalListGroupFlushRow`)
 * is the mechanism: any row built on `PortalPropertyRecordRow` reads it and
 * drops its own card chrome while inside a group's rows slot.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortalListGroup } from "@/components/portal/portal-list-group";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";

function row(title: string) {
  return <PortalPropertyRecordRow key={title} title={title} onOpen={() => {}} dataAttr={`row-${title}`} />;
}

afterEach(() => {
  cleanup();
});

describe("PortalListGroup", () => {
  it("renders the header, rows and footer inside ONE bordered, rounded, shadowed container", () => {
    const { container } = render(
      <PortalListGroup
        listKey="payments"
        groupKey="g1"
        name="Noah Park"
        sub="Lakeview Studio · Studio"
        figure="$3,750 due"
        count="4 charges"
        footer={["Paid this year · $16,200"]}
      >
        {row("Rent · Oct 2026")}
        {row("Security deposit")}
      </PortalListGroup>,
    );

    const group = container.querySelector('[data-attr="portal-list-group"]');
    expect(group).toBeTruthy();
    expect(group!.className).toContain("rounded-xl");
    expect(group!.className).toContain("border");
    expect(group!.className).toContain("shadow-sm");

    // The header, the rows and the footer are all descendants of that one container.
    expect(group!.querySelector('[data-attr="portal-list-group-header"]')).toBeTruthy();
    expect(group!.querySelector('[data-attr="row-Rent · Oct 2026"]')).toBeTruthy();
    expect(group!.querySelector('[data-attr="row-Security deposit"]')).toBeTruthy();
    expect(group!.textContent).toContain("Paid this year · $16,200");

    // Neither row draws its own card — no rounded corners, no shadow, no
    // margin — since the outer container already supplies that once.
    for (const title of ["Rent · Oct 2026", "Security deposit"]) {
      const card = container.querySelector(`[data-attr="row-${title}"]`)!.closest(".portal-property-row");
      expect(card?.className).not.toMatch(/(?:^|\s)rounded-xl(?:\s|$)/);
      expect(card?.className).not.toMatch(/(?:^|\s)shadow-sm(?:\s|$)/);
      expect(card?.className).not.toMatch(/(?:^|\s)mb-2(?:\s|$)/);
    }

    // The rows sit inside a hairline-separated list, not floating apart.
    expect(group!.querySelector(".divide-y")).toBeTruthy();
  });

  it("renders a one-fact footer without inventing a second fact", () => {
    const { container } = render(
      <PortalListGroup listKey="payments" groupKey="g1" name="Noah Park" footer={["Paid this year · $16,200"]}>
        {row("Rent · Oct 2026")}
      </PortalListGroup>,
    );
    const group = container.querySelector('[data-attr="portal-list-group"]')!;
    expect(group.textContent).toContain("Paid this year · $16,200");
  });

  it("renders a two-fact footer side by side when both are supplied", () => {
    const { container } = render(
      <PortalListGroup
        listKey="payments"
        groupKey="g1"
        name="Noah Park"
        footer={["Paid this year · $16,200", "Next rent posts Oct 25"]}
      >
        {row("Rent · Oct 2026")}
      </PortalListGroup>,
    );
    const group = container.querySelector('[data-attr="portal-list-group"]')!;
    expect(group.textContent).toContain("Paid this year · $16,200");
    expect(group.textContent).toContain("Next rent posts Oct 25");
  });

  it("collapsing the group hides its whole rows slot at once", () => {
    render(
      <PortalListGroup listKey="payments" groupKey="g1" name="Noah Park" count="2 charges">
        {row("Rent · Oct 2026")}
        {row("Security deposit")}
      </PortalListGroup>,
    );
    expect(screen.getByText("Rent · Oct 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Noah Park/ }));
    expect(screen.queryByText("Rent · Oct 2026")).toBeNull();
    expect(screen.queryByText("Security deposit")).toBeNull();
  });

  it("a row rendered outside any group keeps its own card, unchanged", () => {
    const { container } = render(row("Standalone charge"));
    const card = container.querySelector('[data-attr="row-Standalone charge"]')!.closest(".portal-property-row");
    expect(card?.className).toContain("rounded-xl");
    expect(card?.className).toContain("shadow-sm");
    expect(card?.className).toContain("mb-2");
  });
});
