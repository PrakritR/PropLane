// @vitest-environment jsdom
//
// The shared grouped-list primitive (Residents / Applications by house, Vendors
// by trade), exercised against a synthetic portfolio: 100 houses and 2,000
// residents, so the order, the counts, "Show all", search auto-expand and the
// empty-group rule are proved at the scale the captain asked for.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { PortalGroupedRecordList } from "@/components/portal/portal-grouped-record-list";
import {
  GROUPED_LIST_PAGE_SIZE,
  groupItems,
  resolveGroupCollapsed,
  visibleGroupItems,
} from "@/lib/portal-grouped-list";

type Resident = { id: string; name: string; house: string };

const HOUSES = 100;
const RESIDENTS = 2000;

/** House labels in a scrambled order, so a passing sort is the sort and not the input order. */
function houseName(index: number): string {
  return `Maple House ${((index * 37) % HOUSES) + 1}`;
}

function buildPortfolio(): Resident[] {
  const rows: Resident[] = [];
  for (let i = 0; i < RESIDENTS; i += 1) {
    const house = i % HOUSES;
    rows.push({
      id: `r-${String(i).padStart(4, "0")}`,
      name: `Resident ${String(i).padStart(4, "0")}`,
      house: houseName(house),
    });
  }
  // A handful with no house at all.
  for (let i = 0; i < 7; i += 1) rows.push({ id: `nohouse-${i}`, name: `Drifter ${i}`, house: i % 2 ? "" : "   " });
  return rows;
}

const PORTFOLIO = buildPortfolio();

afterEach(cleanup);

describe("groupItems on a 100-house, 2,000-resident portfolio", () => {
  const groups = groupItems(PORTFOLIO, { groupLabel: (r) => r.house, otherLabel: "No house" });

  it("makes one group per house plus a trailing No house bucket", () => {
    expect(groups).toHaveLength(HOUSES + 1);
    const last = groups[groups.length - 1]!;
    expect(last.label).toBe("No house");
    expect(last.other).toBe(true);
    expect(last.items).toHaveLength(7);
    expect(groups.slice(0, -1).every((g) => !g.other)).toBe(true);
  });

  it("sorts houses A to Z with numbers in numeric order (House 2 before House 10)", () => {
    const labels = groups.slice(0, -1).map((g) => g.label);
    expect(labels[0]).toBe("Maple House 1");
    expect(labels[1]).toBe("Maple House 2");
    expect(labels[9]).toBe("Maple House 10");
    expect(labels[HOUSES - 1]).toBe("Maple House 100");
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  it("counts every resident exactly once and keeps the caller's order inside a group", () => {
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(RESIDENTS + 7);
    const first = groups[0]!;
    expect(first.count).toBe(RESIDENTS / HOUSES);
    const ids = first.items.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("uses countOf for clusters (a household of 3 counts 3) and groupId to keep same-named houses apart", () => {
    const clusters = [
      { id: "a", house: "Alder", size: 3, propertyId: "p1" },
      { id: "b", house: "Alder", size: 1, propertyId: "p2" },
      { id: "c", house: "Alder", size: 2, propertyId: "p1" },
    ];
    const merged = groupItems(clusters, { groupLabel: (c) => c.house, otherLabel: "No house", countOf: (c) => c.size });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.count).toBe(6);
    const split = groupItems(clusters, {
      groupLabel: (c) => c.house,
      groupId: (c) => c.propertyId,
      otherLabel: "No house",
      countOf: (c) => c.size,
    });
    expect(split.map((g) => g.count).sort()).toEqual([1, 5]);
  });
});

describe("Show all arithmetic and the expanded default", () => {
  it("draws the first page and reports how many Show all would add", () => {
    const group = { items: Array.from({ length: 120 }, (_, i) => i) };
    const page = visibleGroupItems(group, false);
    expect(page.items).toHaveLength(GROUPED_LIST_PAGE_SIZE);
    expect(page.hidden).toBe(120 - GROUPED_LIST_PAGE_SIZE);
    expect(visibleGroupItems(group, true)).toEqual({ items: group.items, hidden: 0 });
    expect(visibleGroupItems({ items: [1, 2, 3] }, false)).toEqual({ items: [1, 2, 3], hidden: 0 });
  });

  it("starts every group expanded, however many there are, and lets a click override", () => {
    expect(resolveGroupCollapsed({ override: undefined, searchActive: false })).toBe(false);
    expect(resolveGroupCollapsed({ override: undefined, searchActive: true })).toBe(false);
    expect(resolveGroupCollapsed({ override: true, searchActive: false })).toBe(true);
    expect(resolveGroupCollapsed({ override: false, searchActive: false })).toBe(false);
  });
});

function Harness({ rows, initialSearch = "" }: { rows: Resident[]; initialSearch?: string }) {
  const [search, setSearch] = useState(initialSearch);
  const needle = search.trim().toLowerCase();
  const items = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  return (
    <div>
      <input aria-label="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      <PortalGroupedRecordList
        items={items}
        groupLabel={(r) => r.house}
        otherLabel="No house"
        itemKey={(r) => r.id}
        renderItem={(r) => <div data-testid="row">{r.name}</div>}
        listKey="test"
        searchActive={needle.length > 0}
      />
    </div>
  );
}

describe("PortalGroupedRecordList", () => {
  it("opens 100 houses as 101 expanded groups, each with a plain-text count and its rows mounted", () => {
    const { container } = render(<Harness rows={PORTFOLIO} />);
    const headers = container.querySelectorAll('[data-attr="portal-list-group-header"]');
    expect(headers).toHaveLength(HOUSES + 1);
    expect(screen.getAllByTestId("row")).toHaveLength(RESIDENTS + 7);
    const first = headers[0]!;
    expect(first.textContent).toContain("Maple House 1");
    expect(first.textContent).toContain(String(RESIDENTS / HOUSES));
    expect(first.getAttribute("aria-expanded")).toBe("true");
    // Sticky band, count is plain text (no pill / badge shape).
    expect(first.className).toContain("sticky");
    expect(first.querySelector(".rounded-full")).toBeNull();
    expect(headers[headers.length - 1]!.textContent).toContain("No house");
  });

  it("collapses one house from its header and reopens it", () => {
    const { container } = render(<Harness rows={PORTFOLIO} />);
    const first = container.querySelector('[data-attr="portal-list-group-header"]') as HTMLElement;
    const group = first.closest('[data-attr="test-group"]') as HTMLElement;
    expect(within(group).getAllByTestId("row")).toHaveLength(RESIDENTS / HOUSES);
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(within(group).queryAllByTestId("row")).toHaveLength(0);
    fireEvent.click(first);
    expect(within(group).getAllByTestId("row")).toHaveLength(RESIDENTS / HOUSES);
  });

  it("draws only a house's first 25 rows, and Show all draws the rest", () => {
    const big: Resident[] = Array.from({ length: 140 }, (_, i) => ({
      id: `b-${i}`,
      name: `Big ${String(i).padStart(3, "0")}`,
      house: "Tower",
    }));
    const rows = [...big, ...PORTFOLIO.filter((r) => r.house.trim())];
    const { container } = render(<Harness rows={rows} />);
    const tower = [...container.querySelectorAll('[data-attr="portal-list-group-header"]')].find((h) =>
      h.textContent?.includes("Tower"),
    ) as HTMLElement;
    expect(tower.textContent).toContain("140");
    const group = tower.closest('[data-attr="test-group"]') as HTMLElement;
    expect(within(group).getAllByTestId("row")).toHaveLength(GROUPED_LIST_PAGE_SIZE);
    fireEvent.click(within(group).getByRole("button", { name: "Show all 140" }));
    expect(within(group).getAllByTestId("row")).toHaveLength(140);
    expect(within(group).queryByRole("button", { name: /Show all/ })).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "Show fewer" }));
    expect(within(group).getAllByTestId("row")).toHaveLength(GROUPED_LIST_PAGE_SIZE);
  });

  it("draws no expand-all or collapse-all control", () => {
    render(<Harness rows={PORTFOLIO} />);
    expect(screen.queryByRole("button", { name: /Expand all|Collapse all/ })).toBeNull();
  });

  it("an active search opens the houses that still match and draws no empty group", () => {
    const { container } = render(<Harness rows={PORTFOLIO} />);
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "Resident 0042" } });
    // One resident matches: exactly one group survives, already open, with that one row.
    const headers = container.querySelectorAll('[data-attr="portal-list-group-header"]');
    expect(headers).toHaveLength(1);
    expect(headers[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("row")).toHaveLength(1);
    expect(screen.getByText("Resident 0042")).toBeTruthy();
  });

  it("a search that matches nothing draws no groups at all, and clearing it brings every header back open", () => {
    const { container } = render(<Harness rows={PORTFOLIO} />);
    const input = screen.getByLabelText("search");
    fireEvent.change(input, { target: { value: "zzzz-no-such-resident" } });
    expect(container.querySelectorAll('[data-attr="portal-list-group-header"]')).toHaveLength(0);
    fireEvent.change(input, { target: { value: "" } });
    expect(container.querySelectorAll('[data-attr="portal-list-group-header"]')).toHaveLength(HOUSES + 1);
    expect(screen.getAllByTestId("row")).toHaveLength(RESIDENTS + 7);
  });

  it("a short list (3 houses) starts open", () => {
    const rows = PORTFOLIO.filter((r) => r.house === houseName(0) || r.house === houseName(1) || r.house === houseName(2));
    const { container } = render(<Harness rows={rows} />);
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(3);
    expect(screen.getAllByTestId("row").length).toBe(rows.length);
  });
});
