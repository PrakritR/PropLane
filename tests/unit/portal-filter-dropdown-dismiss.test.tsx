// @vitest-environment jsdom
/**
 * PRP-386 — the desktop Filter dropdown is a dialog with a way out.
 *
 * It opened as a `role="dialog"` popover that took no focus, ignored Escape,
 * ignored a click on its own dimmed backdrop, and ignored a second press of the
 * Filter button — the only exit was the header ✕. A keyboard user could not
 * reach its controls and then could not get rid of it, and while it stayed up
 * it covered the list rows underneath.
 *
 * Now: focus moves into the panel when it opens; Escape, the backdrop, and the
 * trigger all close it (committing the draft filters exactly as ✕ does); and
 * focus returns to the Filter button. Escape while a portaled field menu is
 * open closes only that menu — the panel waits for the next Escape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";

function installDesktopPortalViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })),
  });
}

function Harness() {
  const [applied, setApplied] = useState<string[]>([]);
  const options = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, label: `Property ${i}` }));
  return (
    <>
      <p data-testid="applied-count">{applied.length}</p>
      <PortalFilterSortSheet activeCount={applied.length} onReset={() => setApplied([])}>
        <ApplicationFilterSortFields
          propertyOptions={options}
          propertyFilters={applied}
          onPropertyFiltersChange={setApplied}
          dataAttr="dismiss-filter-property"
        />
      </PortalFilterSortSheet>
    </>
  );
}

function filterTrigger() {
  return screen.getByRole("button", { name: /^Filter/ });
}

function dropdownPanel(): HTMLElement | null {
  return document.querySelector('[data-attr="portal-filter-dropdown-panel"]');
}

async function openDropdown() {
  fireEvent.click(filterTrigger());
  await waitFor(() => expect(dropdownPanel()).toBeTruthy());
  return dropdownPanel()!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PortalFilterSortSheet — desktop dropdown dismissal (PRP-386)", () => {
  it("moves focus into the dialog when it opens", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    const panel = await openDropdown();
    expect(panel.getAttribute("role")).toBe("dialog");
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  });

  it("Escape closes it and returns focus to the Filter button", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    await openDropdown();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dropdownPanel()).toBeNull());
    expect(document.activeElement).toBe(filterTrigger());
  });

  it("a click on the dimmed backdrop closes it", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    await openDropdown();
    const backdrop = document.querySelector('[data-attr="portal-filter-dropdown-backdrop"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    await waitFor(() => expect(dropdownPanel()).toBeNull());
  });

  it("a second press of the Filter button closes it", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    await openDropdown();
    expect(filterTrigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(filterTrigger());
    await waitFor(() => expect(dropdownPanel()).toBeNull());
    expect(filterTrigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape with a field menu open closes only the menu; the next Escape closes the panel", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    const panel = await openDropdown();
    fireEvent.click(within(panel).getByRole("button", { name: /Property/ }));
    await waitFor(() => expect(document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)).toBeTruthy());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)).toBeNull());
    expect(dropdownPanel()).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dropdownPanel()).toBeNull());
  });

  it("closing by Escape commits the draft filters exactly like ✕", async () => {
    installDesktopPortalViewport();
    render(<Harness />);
    const panel = await openDropdown();
    fireEvent.click(within(panel).getByRole("button", { name: /Property/ }));
    const option = await screen.findByText("Property 1");
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByTestId("applied-count")).toHaveTextContent("0");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)).toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(dropdownPanel()).toBeNull());
    await waitFor(() => expect(screen.getByTestId("applied-count")).toHaveTextContent("1"));
  });
});
