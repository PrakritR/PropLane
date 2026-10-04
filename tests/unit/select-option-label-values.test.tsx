// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Select } from "@/components/ui/input";

afterEach(() => cleanup());

function openList() {
  fireEvent.click(document.querySelector('[data-attr="select-source"]') as HTMLElement);
  return within(screen.getByRole("listbox"));
}

describe("Select options without a value attribute", () => {
  it("checks only the selected option, never every one of them", () => {
    render(
      <Select id="source" aria-label="Source" value="Airbnb" onChange={() => {}}>
        {["Direct", "Tenant", "Airbnb"].map((v) => <option key={v}>{v}</option>)}
      </Select>,
    );
    const list = openList();
    const selected = list.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.textContent?.trim())).toEqual(["Airbnb"]);
  });

  it("choosing an option saves its label as the value", () => {
    const onChange = vi.fn();
    render(
      <Select id="source" aria-label="Source" value="Direct" onChange={onChange}>
        {["Direct", "Tenant", "Airbnb"].map((v) => <option key={v}>{v}</option>)}
      </Select>,
    );
    const list = openList();
    const option = list.getByRole("option", { name: /Tenant/ });
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("Tenant");
  });

  it("an explicit value (including the empty one) still wins over the label", () => {
    render(
      <Select id="source" aria-label="Source" value="" onChange={() => {}}>
        <option value="">Not set</option>
        <option value="y">Yes</option>
      </Select>,
    );
    const list = openList();
    const selected = list.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.textContent?.trim())).toEqual(["Not set"]);
  });
});
