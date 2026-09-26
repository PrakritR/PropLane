// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { registerFilterSheetDismissGuard } from "@/components/ui/field-select-portal-interaction";
import { Select } from "@/components/ui/input";

function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

function scrollGesture(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 60 });
}

describe("FieldSingleSelect listbox pick", () => {
  const options = Array.from({ length: 9 }, (_, index) => ({
    value: `room-${index}`,
    label: `Room ${index + 1} · ${index + 1}st floor · $825/mo`,
  }));

  it("selects an option on tap", () => {
    let value = "";
    render(
      <FieldSingleSelect
        label="Room (optional)"
        value={value}
        onChange={(next) => {
          value = next;
        }}
        options={[{ value: "", label: "No room" }, ...options]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Room (optional)", expanded: false }));
    const listbox = screen.getByRole("listbox");
    tapOption(within(listbox).getByText("Room 5 · 5st floor · $825/mo"));
    expect(value).toBe("room-4");
    cleanup();
  });

  it.each(["{Enter}", " "])("selects a real option button with keyboard %s", async (key) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FieldSingleSelect label="Room" value="" onChange={onChange} options={options} />);

    await user.click(screen.getByRole("button", { name: "Room" }));
    const option = within(screen.getByRole("listbox")).getByRole("option", { name: /Room 5/ });
    option.focus();
    await user.keyboard(key);

    expect(onChange).toHaveBeenCalledExactlyOnceWith("room-4");
    cleanup();
  });

  it("accepts an assistive zero-detail click but refuses a disabled option", () => {
    const onChange = vi.fn();
    const guard = vi.fn();
    const unregisterGuard = registerFilterSheetDismissGuard(guard);
    render(<FieldSingleSelect label="Room" value="" onChange={onChange} options={[options[0], { ...options[1], disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Room" }));

    fireEvent.click(screen.getByRole("option", { name: /Room 2/ }), { detail: 0 });
    tapOption(screen.getByRole("option", { name: /Room 2/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /Room 1/ }), { detail: 0 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("room-0");
    expect(guard).toHaveBeenCalled();
    unregisterGuard();
    cleanup();
  });

  it("picks once for pointerup followed by the physical click", () => {
    const onChange = vi.fn();
    const guard = vi.fn();
    const unregisterGuard = registerFilterSheetDismissGuard(guard);
    render(<FieldSingleSelect label="Room" value="" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "Room" }));
    const option = screen.getByRole("option", { name: /Room 1/ });

    tapOption(option);
    fireEvent.click(option, { detail: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("room-0");
    expect(guard).toHaveBeenCalled();
    unregisterGuard();
    cleanup();
  });

  it("does not select when the gesture moves more than pick slop (scroll)", () => {
    let value = "";
    render(
      <FieldSingleSelect
        label="Room (optional)"
        value={value}
        onChange={(next) => {
          value = next;
        }}
        options={[{ value: "", label: "No room" }, ...options]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Room (optional)", expanded: false }));
    const listbox = screen.getByRole("listbox");
    scrollGesture(within(listbox).getByText("Room 1 · 1st floor · $825/mo"));
    fireEvent.click(within(listbox).getByRole("option", { name: /Room 1/ }), { detail: 1 });
    expect(value).toBe("");
    expect(screen.getByRole("listbox")).toBeTruthy();
    cleanup();
  });

  it("Select (native-select API) scrolls without picking — property-style house list", () => {
    let propertyId = "";
    const houses = Array.from({ length: 12 }, (_, index) => (
      <option key={`mgr-${index}`} value={`mgr-${index}`}>
        {`House ${index + 1} · ${index + 1} rooms`}
      </option>
    ));

    render(
      <Select
        aria-label="Property (optional)"
        value={propertyId}
        onChange={(e) => {
          propertyId = e.target.value;
        }}
      >
        <option value="">No property</option>
        {houses}
      </Select>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Property (optional)", expanded: false }));
    const listbox = screen.getByRole("listbox");
    scrollGesture(within(listbox).getByText("House 1 · 1 rooms"));
    expect(propertyId).toBe("");
    tapOption(within(listbox).getByText("House 8 · 8 rooms"));
    expect(propertyId).toBe("mgr-7");
    cleanup();
  });
});
