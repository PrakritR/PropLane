// @vitest-environment jsdom
//
// M017 — ReorderList primitive (src/components/ui/motion/reorder-list.tsx),
// ported from interior.dev's Reorder List technique WITHOUT its `motion`
// dependency (see the component's own header). Keyboard path — arm the grip,
// then Arrow Up/Down — is the primary coverage here since a real pointer
// drag depends on `elementFromPoint`, which jsdom does not implement
// meaningfully.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReorderList } from "@/components/ui/motion/reorder-list";

afterEach(() => cleanup());

type Row = { id: string; name: string };

function Controlled({ initial, onReorder }: { initial: Row[]; onReorder?: (next: Row[]) => void }) {
  const [items, setItems] = useState(initial);
  return (
    <ReorderList
      items={items}
      label="Fees"
      onReorder={(next) => {
        setItems(next);
        onReorder?.(next);
      }}
      renderRow={(item) => <span>{item.name}</span>}
    />
  );
}

function order() {
  return Array.from(document.querySelectorAll('[role="listitem"]')).map((el) => el.textContent?.replace("⠿", ""));
}

describe("ReorderList", () => {
  it("renders one listitem per row, each with a grip", () => {
    render(<Controlled initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /row 1 of 2/ })).toBeInTheDocument();
  });

  it("moves a row down with the keyboard: arm the grip, then Arrow Down", () => {
    const onReorder = vi.fn();
    render(
      <Controlled
        initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }, { id: "c", name: "HOA" }]}
        onReorder={onReorder}
      />,
    );
    const grip = screen.getByRole("button", { name: /row 1 of 3/ });
    fireEvent.click(grip); // arm
    expect(grip).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onReorder).toHaveBeenCalledWith([
      { id: "b", name: "Parking" },
      { id: "a", name: "Pet fee" },
      { id: "c", name: "HOA" },
    ]);
  });

  it("does nothing on Arrow keys while not armed", () => {
    const onReorder = vi.fn();
    render(<Controlled initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }]} onReorder={onReorder} />);
    const grip = screen.getByRole("button", { name: /row 1 of 2/ });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("Escape disarms without moving anything", () => {
    const onReorder = vi.fn();
    render(<Controlled initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }]} onReorder={onReorder} />);
    const grip = screen.getByRole("button", { name: /row 1 of 2/ });
    fireEvent.click(grip);
    fireEvent.keyDown(grip, { key: "Escape" });
    expect(grip).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("refuses to move the last row further down (a no-op, not a wrap-around)", () => {
    const onReorder = vi.fn();
    render(<Controlled initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }]} onReorder={onReorder} />);
    const grip = screen.getByRole("button", { name: /row 2 of 2/ });
    fireEvent.click(grip);
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("updates the rendered row order after a keyboard move", () => {
    render(<Controlled initial={[{ id: "a", name: "Pet fee" }, { id: "b", name: "Parking" }]} />);
    expect(order()).toEqual(["Pet fee", "Parking"]);
    fireEvent.click(screen.getByRole("button", { name: /row 1 of 2/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /row 1 of 2/ }), { key: "ArrowDown" });
    expect(order()).toEqual(["Parking", "Pet fee"]);
  });
});
