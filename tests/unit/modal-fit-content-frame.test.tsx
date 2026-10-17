// @vitest-environment jsdom
/**
 * Captain decision (2026-10-16): every pop-up fits its content up to the current maximum; it is no longer a
 * fixed 920 x 640 window. A wide multi-step wizard opts back into the fixed window with `fixedSize`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { MODAL_FIT_PANEL_CLASS, MODAL_STANDARD_PANEL_CLASS } from "@/components/ui/modal-styles";

afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  vi.unstubAllGlobals();
});

function desktop() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine") || query.includes("min-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
}

function panel() {
  return document.querySelector<HTMLElement>('[data-slot="modal-radix-dialog"]');
}

describe("the pop-up frame", () => {
  it("the fit frame has an auto height capped at 640 and keeps the phone sheet", () => {
    expect(MODAL_FIT_PANEL_CLASS).toContain("!h-auto");
    expect(MODAL_FIT_PANEL_CLASS).toContain("min(640px");
    expect(MODAL_FIT_PANEL_CLASS).toContain("max-sm:!h-[100dvh]");
    expect(MODAL_FIT_PANEL_CLASS).not.toMatch(/!h-\[min\(640px/);
    expect(MODAL_STANDARD_PANEL_CLASS).toMatch(/!h-\[min\(640px/);
  });

  it("a default Modal is content-height, not a fixed 640", () => {
    desktop();
    render(<Modal open title="Change password" onClose={() => {}} footer={<span>Save</span>}>body</Modal>);
    const cls = panel()?.className ?? "";
    expect(cls).toContain("!h-auto");
    expect(cls).not.toMatch(/!h-\[min\(640px/);
  });

  it("fixedSize keeps the 920 x 640 window for a wizard with a step rail", () => {
    desktop();
    render(<Modal open fixedSize title="Wizard" onClose={() => {}}>body</Modal>);
    expect(panel()?.className ?? "").toMatch(/!h-\[min\(640px/);
  });

  it("a pop-up with no side rails narrows to a form width", () => {
    desktop();
    render(<Modal open title="Rename" contextPanel={null} preview={null} onClose={() => {}}>body</Modal>);
    expect(panel()?.className ?? "").toContain("sm:!max-w-[640px]");
  });
});
