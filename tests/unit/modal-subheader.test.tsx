// @vitest-environment jsdom
//
// PLAN-0920-2357 stream C: Modal gained an optional `subheader` slot rendered
// as its own row directly under the title row, inside the header chrome —
// distinct from `status`, which renders INSIDE the title row (see
// pro-portal-settings-modal.tsx, which used to pass the property/workspace
// scope bar as `status` and had it overlap the title on narrow dialogs).
// Absent `subheader`, the header must render byte-identical to before: no
// extra wrapper element, no class change on the title row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";

afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  vi.unstubAllGlobals();
});

function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

/** The header chrome block: title row, optional subheader row, optional description. */
function modalHeader(): HTMLElement {
  const dialog = screen.getByRole("dialog");
  const panelInner = dialog.children[0] as HTMLElement;
  return panelInner.children[0] as HTMLElement;
}

describe("Modal subheader", () => {
  it("renders no subheader row and no extra wrapper when absent", () => {
    mockDesktopMatchMedia();
    render(
      <Modal open title="Payment settings" onClose={() => {}}>
        <p>content</p>
      </Modal>,
    );
    const header = modalHeader();
    // Only the title row — no subheader wrapper was added.
    expect(header.children).toHaveLength(1);
    expect(screen.queryByText(/scope/i)).toBeNull();
  });

  it("renders the subheader under the title row, outside the title's own flex row, when present", () => {
    mockDesktopMatchMedia();
    render(
      <Modal open title="Payment settings" onClose={() => {}} subheader={<span>Scope: All properties</span>}>
        <p>content</p>
      </Modal>,
    );
    const header = modalHeader();
    const titleRow = header.children[0] as HTMLElement;
    // The title text itself lives in the title row...
    expect(titleRow.textContent).toContain("Payment settings");
    // ...and the subheader node is NOT inside it.
    expect(titleRow.textContent).not.toContain("Scope: All properties");

    const subheaderRow = header.children[1] as HTMLElement;
    expect(subheaderRow.textContent).toContain("Scope: All properties");
    expect(subheaderRow.className).toContain("mt-2");

    const subheaderNode = screen.getByText("Scope: All properties");
    // Sits under the title row, not nested inside it.
    expect(titleRow.contains(subheaderNode)).toBe(false);
  });

  it("keeps status inside the title row, distinct from subheader", () => {
    mockDesktopMatchMedia();
    render(
      <Modal
        open
        title="Payment settings"
        onClose={() => {}}
        status={<span>Saved</span>}
        subheader={<span>Scope: All properties</span>}
      >
        <p>content</p>
      </Modal>,
    );
    const header = modalHeader();
    const titleRow = header.children[0] as HTMLElement;
    expect(titleRow.textContent).toContain("Saved");
    expect(titleRow.textContent).not.toContain("Scope: All properties");
    const subheaderRow = header.children[1] as HTMLElement;
    expect(subheaderRow.textContent).toBe("Scope: All properties");
  });
});
