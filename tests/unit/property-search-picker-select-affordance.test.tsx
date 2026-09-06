// @vitest-environment jsdom
/**
 * The room/property picker rows show a labelled "Select" button, not a bare radio
 * circle. The circle read as decoration rather than a control — prospects on the
 * public tour flow could not tell a room had to be chosen — so the affordance is
 * a named button on every row.
 *
 * It must stay a NON-interactive element: the row itself is the `<button>` and the
 * listbox option, so a nested button would be invalid markup and a second tab stop
 * on every row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PropertySearchPicker } from "@/components/marketing/property-search-picker";

const OPTIONS = [
  { id: "room-1", title: "Room 1 · 1st floor · $500/mo", subtitle: "4534 Darrow Ct · 4 rooms" },
  { id: "room-2", title: "Room 2 · 1st floor · $600/mo", subtitle: "4534 Darrow Ct · 4 rooms" },
];

afterEach(cleanup);

describe("PropertySearchPicker select affordance", () => {
  it("labels every row with Select", () => {
    render(<PropertySearchPicker options={OPTIONS} value={null} onChange={() => {}} />);
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByText("Select")).toBeTruthy();
    }
  });

  it("keeps one control per row — the Select label is not its own button", () => {
    const { container } = render(
      <PropertySearchPicker options={OPTIONS} value={null} onChange={() => {}} />,
    );
    for (const row of screen.getAllByRole("option")) {
      expect(row.querySelectorAll("button")).toHaveLength(1);
    }
    // and no nested <button> anywhere in the list
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });

  it("marks the chosen row selected once the list is open", () => {
    render(<PropertySearchPicker options={OPTIONS} value="room-2" onChange={() => {}} />);
    // A picker with a selection collapses to a summary card; focusing the search
    // input is how a prospect reopens the list to change rooms.
    fireEvent.focus(screen.getByRole("searchbox"));
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(within(rows[1]).getByText("Select").className).toContain("bg-primary");
    expect(within(rows[0]).getByText("Select").className).not.toContain("bg-primary");
  });
});
