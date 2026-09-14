// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToggleChips } from "@/components/ui/toggle-chips";

afterEach(cleanup);

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie", disabled: true },
];

describe("ToggleChips", () => {
  it("renders one pressed button per option inside a labelled group", () => {
    render(<ToggleChips label="Letters" options={options} selected={["a"]} onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Letters" });
    expect(group.querySelectorAll("button").length).toBe(3);
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Bravo" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("adds on tap and removes on a second tap, preserving the others", () => {
    const onChange = vi.fn();
    render(<ToggleChips label="Letters" options={options} selected={["a"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Bravo" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("ignores a disabled option and a disabled group", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ToggleChips label="Letters" options={options} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Charlie" }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<ToggleChips label="Letters" options={options} selected={[]} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stamps a per-chip data-attr and renders the trailing slot in the row", () => {
    render(
      <ToggleChips
        label="Letters"
        options={options}
        selected={[]}
        onChange={() => {}}
        dataAttr="letters"
        trailing={<span data-testid="trailing">+ Custom</span>}
      />,
    );
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("data-attr")).toBe("letters-a");
    expect(screen.getByRole("group", { name: "Letters" }).contains(screen.getByTestId("trailing"))).toBe(true);
  });
});
