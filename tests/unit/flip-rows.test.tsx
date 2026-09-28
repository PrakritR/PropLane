// @vitest-environment jsdom
//
// M016 — useFlipRows (flip-rows.ts), the row-travel half of the sortable
// table primitive. Exercised directly (not just through the admin table) so
// its reduced-motion contract is pinned independent of any one host.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useFlipRows } from "@/components/ui/motion/flip-rows";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function List({ order }: { order: string[] }) {
  const { registerRow } = useFlipRows(order);
  return (
    <ul>
      {order.map((key) => (
        <li key={key} ref={registerRow(key)} data-testid={`row-${key}`}>
          {key}
        </li>
      ))}
    </ul>
  );
}

describe("useFlipRows", () => {
  it("never applies a FLIP transform under reduced motion", () => {
    stubMatchMedia(true);
    const { rerender } = render(<List order={["a", "b", "c"]} />);
    act(() => rerender(<List order={["c", "b", "a"]} />));
    for (const key of ["a", "b", "c"]) {
      const el = document.querySelector(`[data-testid="row-${key}"]`) as HTMLElement;
      expect(el.style.transform).toBe("");
      expect(el.classList.contains("motion-flip-row")).toBe(false);
    }
  });

  it("does not throw when re-registering rows across a re-order (motion on)", () => {
    stubMatchMedia(false);
    const { rerender } = render(<List order={["a", "b", "c"]} />);
    expect(() => act(() => rerender(<List order={["c", "a", "b"]} />))).not.toThrow();
    expect(document.querySelectorAll("li")).toHaveLength(3);
  });
});
