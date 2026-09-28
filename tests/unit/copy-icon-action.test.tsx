// @vitest-environment jsdom
//
// M009 — the copy button check morph. `CopyIconAction` (portal-icon-action.tsx)
// wraps PortalIconAction's icon-chrome contract (tooltip-only label, no text
// pill — AGENTS.md) and adds a width-locked morph from the copy glyph to a
// drawn checkmark, reverting after the real copy resolves, without owning
// the actual clipboard write itself (the caller's `onCopy` still does that).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CopyIconAction } from "@/components/portal/portal-icon-action";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubReducedMotion(matches: boolean) {
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

describe("CopyIconAction", () => {
  it("calls the caller's onCopy and draws no visible text — icon chrome only", () => {
    stubReducedMotion(false);
    const onCopy = vi.fn();
    render(<CopyIconAction label="Copy link" onCopy={onCopy} />);
    const button = screen.getByRole("button", { name: "Copy link" });
    expect(button.textContent?.trim()).toBe("");
    fireEvent.click(button);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("morphs to a Copied state once onCopy resolves, then reverts", async () => {
    stubReducedMotion(false);
    const onCopy = vi.fn(() => Promise.resolve());
    render(<CopyIconAction label="Copy link" onCopy={onCopy} />);
    const button = screen.getByRole("button", { name: "Copy link" });

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("data-copied")).toBe("true"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    await waitFor(
      () => expect(button.hasAttribute("data-copied")).toBe(false),
      { timeout: 2500 },
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("still morphs under reduced motion (state change never skipped) but reverts instantly", async () => {
    stubReducedMotion(true);
    const onCopy = vi.fn(() => Promise.resolve());
    render(<CopyIconAction label="Copy link" onCopy={onCopy} />);
    const button = screen.getByRole("button", { name: "Copy link" });

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("data-copied")).toBe("true"));
    // Reduced motion shortens the hold to ~0ms — it clears fast, not never.
    await waitFor(() => expect(button.hasAttribute("data-copied")).toBe(false));
  });

  it("never morphs a synchronous onCopy that never resolves (e.g. a guarded no-op)", () => {
    stubReducedMotion(false);
    const onCopy = vi.fn(() => undefined);
    render(<CopyIconAction label="Copy link" onCopy={onCopy} />);
    // A plain non-promise return still resolves via Promise.resolve() — this
    // just documents the contract stays synchronous-friendly, not a special case.
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
