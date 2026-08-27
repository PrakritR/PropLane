// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
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
