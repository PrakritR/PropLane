// @vitest-environment jsdom
/**
 * A dialog opened from a dropdown menu item must leave the page clickable (Oct 14 2026).
 *
 * Radix pins its internal packages to EXACT versions, so `react-dialog` asked for
 * `react-dismissable-layer@1.1.13` while `react-menu` asked for `1.1.14` and npm installed both.
 * `DismissableLayer` keeps `originalBodyPointerEvents` and its layer set at MODULE scope, so two
 * copies cannot see each other: the menu's copy set `document.body.style.pointerEvents = "none"`,
 * the dialog's copy then captured "none" as the value to restore, and closing the dialog wrote it
 * back — every click on the page dead until a reload. The measured sequence was
 * `menu open: none -> dialog open: "" -> dialog closed: none`.
 *
 * The fix is the `overrides` block in package.json pinning one copy of each stateful Radix
 * internal. These two tests are the guard: the behaviour, and the single-copy invariant that
 * a lockfile regeneration must not quietly undo.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModalShell } from "@/components/ui/modal";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
});
afterEach(cleanup);

/** The Bookings calendar-bar shape: a menu item opens a confirm dialog. */
function BarWithDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>Block</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setOpen(true)}>Unblock</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open ? (
        <ModalShell open onClose={() => setOpen(false)} presentation="modal" ariaLabel="Remove this reservation?">
          <button type="button" onClick={() => setOpen(false)}>Close</button>
        </ModalShell>
      ) : null}
    </>
  );
}

describe("a dialog opened from a dropdown menu", () => {
  it("hands body pointer-events back when it closes, so the page underneath still takes clicks", async () => {
    render(<BarWithDialog />);
    expect(document.body.style.pointerEvents).toBe("");

    fireEvent.keyDown(screen.getByText("Block"), { key: "ArrowDown" });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Unblock" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });

    expect(document.body.style.pointerEvents).toBe("");
  });
});

describe("one copy of every Radix primitive that keeps module-scope state", () => {
  // `react-menu` (the dropdown) and `react-dialog` must agree on these, or the layer set and the
  // saved body pointer-events live in two places that never see each other.
  it.each(["@radix-ui/react-dismissable-layer", "@radix-ui/react-focus-scope"])("%s resolves to the same file for the menu and the dialog", (pkg) => {
    const require_ = createRequire(`${process.cwd()}/package.json`);
    const from = (host: string) => require_.resolve(pkg, { paths: [`${process.cwd()}/node_modules/@radix-ui/${host}`] });
    expect(from("react-menu")).toBe(from("react-dialog"));
  });
});
