/** @vitest-environment jsdom */
/**
 * "Make sure all popups like this implement liquid UI and blur background."
 *
 * Every dropdown menu is the approved liquid-glass surface over a blurred,
 * dimmed page BY DEFAULT — the ＋ menu on Properties used to be a flat white
 * card because glass and the scrim were opt-in props. The only opt-out is
 * `backdrop={false}` for a menu that already sits inside a modal, whose own
 * overlay is the blur.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

afterEach(cleanup);

function Menu(props: { backdrop?: boolean; glass?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Add property</DropdownMenuTrigger>
      <DropdownMenuContent {...props}>
        <DropdownMenuItem>Add property</DropdownMenuItem>
        <DropdownMenuItem>Import properties</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenuContent liquid default", () => {
  it("renders the glass surface and the page backdrop with no props", async () => {
    render(<Menu />);
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("portal-liquid-glass");
    const backdrop = screen.getByTestId("dropdown-menu-backdrop");
    expect(backdrop.className).toContain("portal-menu-backdrop");
    // A click outside must still close the menu in one tap.
    expect(backdrop.className).toContain("pointer-events-none");
  });

  it("skips only the backdrop for a menu inside a modal", async () => {
    render(<Menu backdrop={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Add property" }));
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("portal-liquid-glass");
    expect(screen.queryByTestId("dropdown-menu-backdrop")).toBeNull();
  });
});
