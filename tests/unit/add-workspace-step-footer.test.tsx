// @vitest-environment jsdom
//
// The approved pop-up footer (dashboard-redesign-1007): Back / Delete at the left, a centred
// "Step n of N" in grey, the primary at the right naming its outcome. The rail beside it numbers
// every step and marks the current one.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AddWorkspace } from "@/components/portal/add-workspace";

afterEach(cleanup);

const STEPS = [
  { id: "basics", label: "Basics" },
  { id: "rooms", label: "Rooms" },
  { id: "review", label: "Review" },
];

function mount(current: number, extra: Partial<Parameters<typeof AddWorkspace>[0]> = {}, steps = STEPS) {
  return render(
    <AddWorkspace
      title="New property"
      steps={steps}
      current={current}
      onJump={() => undefined}
      onClose={() => undefined}
      assistantContext="x"
      assistantScopeKey="x"
      lastLabel="Create property"
      onFinish={() => undefined}
      {...extra}
    >
      <p>body</p>
    </AddWorkspace>,
  );
}

describe("AddWorkspace footer step count", () => {
  it("reads Step n of N for each step of a multi-step pop-up", () => {
    const { unmount } = mount(0);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    unmount();
    mount(1);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("keeps Back beside the primary and names the outcome on the last step", () => {
    mount(2);
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create property" })).toBeTruthy();
  });

  it("draws no count for a one-step pop-up or when the door hides it", () => {
    const { unmount } = mount(0, {}, [{ id: "only", label: "Only" }]);
    expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
    unmount();
    mount(1, { hideFooterStepCount: true });
    expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
  });
});

describe("AddWorkspace step rail", () => {
  it("numbers every step and marks the current one", () => {
    mount(1);
    const rail = (id: string) => document.querySelector<HTMLElement>(`[data-attr="listing-v2-rail-${id}"]`)!;
    expect(rail("rooms").getAttribute("aria-current")).toBe("step");
    expect(rail("basics").getAttribute("aria-current")).toBeNull();
    expect(rail("basics").querySelector("[data-step-number='1']")?.textContent).toBe("1");
    expect(rail("review").querySelector("[data-step-number='3']")?.textContent).toBe("3");
  });
});
