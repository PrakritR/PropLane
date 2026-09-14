// @vitest-environment jsdom
//
// The listing editor's grid cells are the PropLane dropdown at cell size:
// 36px, same radius as the text inputs beside them, dashed and grey while
// they still follow the "every row" default — and they open the very same
// white portaled menu as every 44px form field.
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Select } from "@/components/ui/input";
import { RowSelectCell } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(() => cleanup());

const FLOORS = [
  { value: "basement", label: "Basement" },
  { value: "1", label: "1st floor" },
  { value: "2", label: "2nd floor" },
];

function tap(target: Element) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("FieldSingleSelect cell variant", () => {
  it("renders a 36px rounded-lg trigger with no caption label", () => {
    render(<FieldSingleSelect variant="cell" label="Floor for Room 1" value="1" onChange={() => {}} options={FLOORS} />);
    const trigger = screen.getByRole("button", { name: "Floor for Room 1" });
    expect(trigger.className).toContain("min-h-[36px]");
    expect(trigger.className).toContain("rounded-lg");
    // 44px is only the native-shell (thumb) override, never the web default.
    expect(trigger.className).not.toMatch(/(^|\s)min-h-\[44px\]/);
    expect(document.querySelector("label")).toBeNull();
    expect(trigger.textContent).toContain("1st floor");
  });

  it("is dashed and grey while it follows the row default, solid once it has its own value", () => {
    const { rerender } = render(
      <FieldSingleSelect variant="cell" inherited label="Floor for Room 1" value="1" onChange={() => {}} options={FLOORS} />,
    );
    const trigger = () => screen.getByRole("button", { name: "Floor for Room 1" });
    expect(trigger().className).toContain("border-dashed");
    expect(trigger().className).toContain("text-muted");
    rerender(<FieldSingleSelect variant="cell" label="Floor for Room 1" value="1" onChange={() => {}} options={FLOORS} />);
    expect(trigger().className).not.toContain("border-dashed");
  });

  it("opens the shared white menu and picks a value", () => {
    let picked = "";
    render(
      <FieldSingleSelect variant="cell" label="Floor for Room 1" value="" placeholder="Floor…" onChange={(v) => (picked = v)} options={FLOORS} />,
    );
    const trigger = screen.getByRole("button", { name: "Floor for Room 1" });
    expect(trigger.textContent).toContain("Floor…");
    fireEvent.click(trigger);
    const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(menu.classList.contains("field-dropdown-menu")).toBe(true);
    expect(menu.querySelector('[role="listbox"]')).not.toBeNull();
    tap(menu.querySelector('[data-field-select-option-value="2"]')!);
    expect(picked).toBe("2");
  });

  it("does not open when disabled", () => {
    render(<FieldSingleSelect variant="cell" disabled label="Bathroom access" value="" onChange={() => {}} options={FLOORS} />);
    const trigger = screen.getByRole("button", { name: "Bathroom access" });
    expect(trigger).toHaveProperty("disabled", true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("RowSelectCell is the cell variant with the wizard's inherited/disabled contract", () => {
    render(
      <RowSelectCell ariaLabel="Floor for every room" value="" options={FLOORS} placeholder="Floor…" inherited disabled onChange={() => {}} />,
    );
    const trigger = screen.getByRole("button", { name: "Floor for every room" });
    expect(trigger.className).toContain("min-h-[36px]");
    expect(trigger.className).toContain("border-dashed");
    expect(trigger).toHaveProperty("disabled", true);
  });

  it("Select forwards variant and inherited to the dropdown", () => {
    render(
      <Select variant="cell" inherited aria-label="Residents per room" value="2" onChange={() => {}}>
        <option value="1">1</option>
        <option value="2">2</option>
      </Select>,
    );
    const trigger = screen.getByRole("button", { name: "Residents per room" });
    expect(trigger.className).toContain("min-h-[36px]");
    expect(trigger.className).toContain("border-dashed");
    expect(trigger.textContent).toContain("2");
  });
});
