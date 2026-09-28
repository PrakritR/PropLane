// @vitest-environment jsdom
//
// M008 — hold-to-confirm on destructive Delete/Remove confirms
// (src/components/ui/motion/hold-to-confirm-button.tsx), wired into the
// shared confirm-delete modal (confirm-delete-modal.tsx via
// PortalDialogAction.confirmGuard). A plain click must be refused; only a
// genuine press-and-hold (pointer or keyboard) commits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HoldToConfirmButton } from "@/components/ui/motion/hold-to-confirm-button";

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

describe("HoldToConfirmButton", () => {
  it("refuses a plain click — the action never fires without a hold", () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={50}>
        Delete
      </HoldToConfirmButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("commits after a pointer hold that clears the gate", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={30}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.pointerDown(btn, { button: 0, clientX: 0, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.pointerUp(btn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancels the hold — no commit — when the pointer releases early", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={5000}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.pointerDown(btn, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(btn);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels the hold when the pointer drifts past tolerance", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={30}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.pointerDown(btn, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(btn, { clientX: 40, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.pointerUp(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("commits on a held Enter, the keyboard fallback", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={30}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.keyDown(btn, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.keyUp(btn, { key: "Enter" });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("commits on a held Space too", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={30}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.keyDown(btn, { key: " " });
    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.keyUp(btn, { key: " " });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("never shortens the hold gate under reduced motion — only the smooth fill is skipped", async () => {
    stubMatchMedia(true);
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={100}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.pointerDown(btn, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(btn);
    // Released well before the (unchanged) hold gate elapsed — must not commit.
    expect(onConfirm).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the button's accessible name exactly the label — the hold hint is description-only", () => {
    render(
      <HoldToConfirmButton onConfirm={() => {}} dataAttr="test-hold">
        Delete
      </HoldToConfirmButton>,
    );
    // An exact-name query only matches if the sr-only hint text did not leak
    // into the accessible name (see the component's own note on why the
    // hint span is aria-hidden despite being referenced by aria-describedby).
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("disables while a returned promise is pending, matching Button's own loading contract", async () => {
    let resolvePromise!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (resolvePromise = resolve)));
    render(
      <HoldToConfirmButton onConfirm={onConfirm} holdMs={20}>
        Delete
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.pointerDown(btn, { button: 0, clientX: 0, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    fireEvent.pointerUp(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    resolvePromise();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
