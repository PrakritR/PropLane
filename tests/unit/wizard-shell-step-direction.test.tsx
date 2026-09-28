// @vitest-environment jsdom
//
// M006 — WizardShell's step panel picks a forward or back transition class
// from the change in `currentStepIndex` ("the same transition is never used
// for both directions" — interior.dev Wizard Steps). WizardShell itself has
// no caller yet in this codebase (verified: `grep -rln "WizardShell" src`
// outside this file returns nothing), so this pins the contract directly for
// whichever wizard adopts it next.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WizardShell, type WizardStep } from "@/components/ui/wizard-shell";

afterEach(cleanup);

const steps: WizardStep[] = [
  { id: "a", label: "Step A" },
  { id: "b", label: "Step B" },
  { id: "c", label: "Step C" },
];

function panel(container: HTMLElement) {
  return container.querySelector(".motion-wiz-dir-fwd, .motion-wiz-dir-back, .min-h-0.flex-1.overflow-y-auto");
}

describe("WizardShell step direction", () => {
  it("carries no direction class on the very first render", () => {
    const { container } = render(
      <WizardShell steps={steps} currentStepIndex={0}>
        Step A body
      </WizardShell>,
    );
    const p = panel(container);
    expect(p?.className).not.toContain("motion-wiz-dir-fwd");
    expect(p?.className).not.toContain("motion-wiz-dir-back");
  });

  it("advancing to a later step index applies the forward class", () => {
    const { container, rerender } = render(
      <WizardShell steps={steps} currentStepIndex={0}>
        Step A body
      </WizardShell>,
    );
    rerender(
      <WizardShell steps={steps} currentStepIndex={1}>
        Step B body
      </WizardShell>,
    );
    expect(panel(container)?.className).toContain("motion-wiz-dir-fwd");
  });

  it("going back to an earlier step index applies the back class", () => {
    const { container, rerender } = render(
      <WizardShell steps={steps} currentStepIndex={2}>
        Step C body
      </WizardShell>,
    );
    rerender(
      <WizardShell steps={steps} currentStepIndex={1}>
        Step B body
      </WizardShell>,
    );
    expect(panel(container)?.className).toContain("motion-wiz-dir-back");
  });

  it("still renders the current step's content after the direction change", () => {
    const { container, rerender, getByText } = render(
      <WizardShell steps={steps} currentStepIndex={0}>
        Step A body
      </WizardShell>,
    );
    rerender(
      <WizardShell steps={steps} currentStepIndex={1}>
        Step B body
      </WizardShell>,
    );
    expect(getByText("Step B body")).toBeTruthy();
    expect(container.textContent).not.toContain("Step A body");
  });
});
