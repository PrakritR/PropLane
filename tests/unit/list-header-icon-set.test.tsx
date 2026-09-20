// @vitest-environment jsdom
//
// The list command band's contract (PLAN-0920-1058 area 1d): only the
// documented icon vocabulary, never a visibly labeled pill, never a ✕, and
// the one primary reads "Add <noun>". `PortalListControlStack` reports every
// violation through `console.error` in a non-production build rather than
// throwing — several shipped panels have not adopted the rule yet, and a
// throwing assertion would crash their render instead of naming the gap.
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Settings2, SlidersHorizontal, Trash2, X } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";

afterEach(cleanup);

function renderStack(props: Partial<ComponentProps<typeof PortalListControlStack>>) {
  return render(
    <PortalListControlStack
      variant="command"
      destinations={[{ id: "all", label: "All", href: "/portal/things" }]}
      {...props}
    />,
  );
}

describe("list command band contract", () => {
  it("draws no visible-text button and one filled primary named 'Add …'", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStack({
      actions: <PortalIconAction icon={SlidersHorizontal} label="Filter" />,
      primary: <PortalPrimaryIconAction label="Add property" />,
    });

    // No button anywhere in the band shows visible text.
    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent?.trim()).toBe("");
    }
    // No ✕ close icon in the band.
    expect(document.querySelector('[data-slot="portal-icon-action"][aria-label="Close"]')).toBeNull();
    // Exactly one filled primary, and its accessible name starts with "Add ".
    const primaries = document.querySelectorAll('[data-slot="portal-primary-icon-action"]');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.getAttribute("aria-label")).toMatch(/^Add\s/);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reports (does not throw) an icon outside the documented vocabulary", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      renderStack({ actions: <PortalIconAction icon={Trash2} label="Delete everything" /> }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("outside the documented list-band vocabulary"));
    errorSpy.mockRestore();
  });

  it("reports a ✕ in the band by name", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStack({ actions: <PortalIconAction icon={X} label="Close" /> });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("never draws a ✕"));
    errorSpy.mockRestore();
  });

  it("reports a labeled pill reaching the band", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStack({ actions: <button type="button">Export</button> });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("labeled pill"));
    errorSpy.mockRestore();
  });

  it("reports a primary whose accessible name is not 'Add <noun>'", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStack({ primary: <PortalPrimaryIconAction label="Create" /> });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it must read "Add <noun>"'));
    errorSpy.mockRestore();
  });

  it("accepts the Settings icon without a report", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStack({ actions: <PortalIconAction icon={Settings2} label="Settings" /> });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
