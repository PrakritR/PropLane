// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useState, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PortalFilterDeferProvider,
  usePortalFilterDraft,
  type PortalFilterDeferController,
} from "@/lib/portal-filter-draft";
import { FilterCheckboxList } from "@/components/portal/filter-field-lists";

const OPTIONS = [
  { value: "p0", label: "Property 0" },
  { value: "p1", label: "Property 1" },
];

function DraftHarness() {
  const controllerRef = useRef<PortalFilterDeferController | null>(null);
  const [applied, setApplied] = useState<string[]>([]);

  return (
    <PortalFilterDeferProvider controllerRef={controllerRef}>
      <p data-testid="applied">{applied.join(",") || "none"}</p>
      <DraftFields applied={applied} onApply={setApplied} />
      <button
        type="button"
        onClick={() => controllerRef.current?.commitAll()}
        data-testid="commit"
      >
        Commit
      </button>
    </PortalFilterDeferProvider>
  );
}

function DraftFields({
  applied,
  onApply,
}: {
  applied: string[];
  onApply: (next: string[]) => void;
}) {
  const [draft, setDraft] = usePortalFilterDraft(applied, onApply, []);
  return (
    <FilterCheckboxList options={OPTIONS} selected={draft} onChange={setDraft} dataAttr="draft-test" />
  );
}

/** A real tap on a listbox row: press and release in place, same pointer, no drag. */
function pickOption(label: string) {
  const target = screen.getByText(label);
  const init = { pointerId: 1, clientX: 10, clientY: 10 };
  fireEvent.pointerDown(target, init);
  fireEvent.pointerUp(target, init);
}

describe("usePortalFilterDraft", () => {
  it("keeps edits in draft until commitAll", async () => {
    render(<DraftHarness />);
    expect(screen.getByTestId("applied")).toHaveTextContent("none");
    // The listbox picks on pointerUP, not pointerDOWN — pointerdown only arms the
    // press, and the pick is discarded if the pointer then moves more than the
    // slop, so `preventDefault` on pointerdown never blocks list scrolling.
    // Firing pointerDown alone therefore picks nothing.
    pickOption("Property 0");
    expect(screen.getByTestId("applied")).toHaveTextContent("none");
    fireEvent.click(screen.getByTestId("commit"));
    await waitFor(() => {
      expect(screen.getByTestId("applied")).toHaveTextContent("p0");
    });
  });

  it("resetAll followed by commitAll applies reset values", async () => {
    function ResetHarness() {
      const controllerRef = useRef<PortalFilterDeferController | null>(null);
      const [applied, setApplied] = useState<string[]>(["p0"]);

      return (
        <PortalFilterDeferProvider controllerRef={controllerRef}>
          <p data-testid="reset-applied">{applied.join(",") || "none"}</p>
          <DraftFields applied={applied} onApply={setApplied} />
          <button
            type="button"
            onClick={() => {
              controllerRef.current?.resetAll();
              controllerRef.current?.commitAll();
            }}
            data-testid="reset"
          >
            Reset
          </button>
        </PortalFilterDeferProvider>
      );
    }

    render(<ResetHarness />);
    expect(screen.getByTestId("reset-applied")).toHaveTextContent("p0");
    fireEvent.click(screen.getByTestId("reset"));
    await waitFor(() => {
      expect(screen.getByTestId("reset-applied")).toHaveTextContent("none");
    });
  });
});
