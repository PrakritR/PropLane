// @vitest-environment jsdom
//
// The Modal body is the one scroll container in both variants. The footer
// variant used to set `overflow-hidden` and rely on every child to hand-roll
// its own scroller — most didn't, so on phones everything below the fold was
// simply clipped and unreachable (no way to scroll to the remaining fields or
// even see them). These tests pin the body as scrollable so that class of bug
// cannot ship again.
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";

afterEach(async () => {
  cleanup();
  // Radix FocusScope restores focus in a queued setTimeout(0) on unmount.
  // Let it finish while this jsdom realm is still installed: otherwise its
  // CustomEvent can be constructed after environment teardown and dispatched
  // onto an element from the old realm, which fails EventTarget's type check.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  vi.unstubAllGlobals();
});

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
    media: "(max-width: 1023px)",
    addEventListener: (_: string, cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_: string, cb: () => void) => {
      listeners.delete(cb);
    },
    dispatchEvent: () => true,
  };
  vi.stubGlobal("matchMedia", () => mql);
  return { mql, listeners };
}

function modalBody(): HTMLElement {
  const dialog = screen.getByRole("dialog");
  // Panel children: header, [row/column switch wrapper], (footer?). The actual
  // scroll container sits one level inside that wrapper (see modal.tsx) so the
  // assistant strip can sit beside it once the panel is wide enough.
  const panelInner = dialog.children[0] as HTMLElement;
  const rowWrapper = panelInner.children[1] as HTMLElement;
  return rowWrapper.children[0] as HTMLElement;
}

describe("Modal scroll container", () => {
  it("body scrolls when a footer is present (no overflow-hidden clipping)", () => {
    render(
      <Modal open title="Tall form" onClose={() => {}} footer={<button type="button">Save</button>}>
        <p>content</p>
      </Modal>,
    );
    const body = modalBody();
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).not.toContain("overflow-hidden");
    // Footer modals grow the scroll band so assistant + actions pin to the panel bottom.
    expect(body.className).toContain("flex-1");
    const panelInner = screen.getByRole("dialog").children[0] as HTMLElement;
    expect(panelInner.className).toContain("flex-1");
  });

  it("body scrolls without a footer too", () => {
    render(
      <Modal open title="Simple" onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    expect(modalBody().className).toContain("overflow-y-auto");
  });
});

describe("Modal Radix / Vaul shell", () => {
  it("calls onClose when Escape is pressed (Radix Dialog)", async () => {
    mockMatchMedia(false);
    const onClose = vi.fn();
    render(
      <Modal open title="Escape test" onClose={onClose}>
        <input aria-label="focus field" />
      </Modal>,
    );
    screen.getByLabelText("focus field").focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders Vaul drawer on small portal viewports", () => {
    mockMatchMedia(true);
    render(
      <Modal open title="Mobile sheet" onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    const drawer = document.querySelector('[data-slot="modal-vaul-drawer"]');
    expect(drawer).toBeTruthy();
    expect(drawer?.className).toContain("h-[100dvh]");
    expect(drawer?.className).toContain("!w-screen");
    expect(drawer?.className).toContain("!max-w-none");
  });

  it("honors fullScreenMobile={false} for a partial-height sheet", () => {
    mockMatchMedia(true);
    render(
      <Modal open title="Compact sheet" onClose={() => {}} fullScreenMobile={false}>
        <p>content</p>
      </Modal>,
    );
    const drawer = document.querySelector('[data-slot="modal-vaul-drawer"]');
    expect(drawer?.className).toContain("max-h-[min(92dvh,56rem)]");
    expect(drawer?.className).not.toContain("h-[100dvh]");
    expect(drawer?.className).toContain("!w-screen");
  });

  it("renders Radix dialog on large portal viewports", () => {
    mockMatchMedia(false);
    render(
      <Modal open title="Desktop dialog" onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    expect(document.querySelector('[data-slot="modal-radix-dialog"]')).toBeTruthy();
  });
});
