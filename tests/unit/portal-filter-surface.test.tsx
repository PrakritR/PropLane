// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalFilterSortSheet, filterApplyLabel } from "@/components/portal/portal-filter-sort-sheet";
import {
  PORTAL_FILTER_DRAFT_PROPERTY_FILTERS,
  usePortalFilterDraft,
  usePortalFilterDraftValues,
} from "@/lib/portal-filter-draft";

/**
 * What the captain's 2026-09-13 screenshots actually showed: a Mac, a mouse, a
 * browser window under 1024px — and a phone bottom sheet with a grabber handle.
 * The surface decision now asks about the POINTER first, so these two cases pin
 * both halves of that: a narrow desktop window keeps the anchored popover, and
 * a touch device still gets the sheet.
 */
function stubMedia(matchers: Record<string, boolean>) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: matchers[query] ?? false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

const MOUSE_IN_A_900PX_WINDOW = {
  "(pointer: fine)": true,
  // True at 900px — the old rule read ONLY this and handed back a sheet.
  "(max-width: 1023px)": true,
  "(max-width: 639px)": false,
};

const A_PHONE = {
  "(pointer: fine)": false,
  "(max-width: 1023px)": true,
  "(max-width: 639px)": true,
};

function openFilter(surface: Record<string, boolean>, applyLabel?: React.ReactNode) {
  stubMedia(surface);
  render(
    <PortalFilterSortSheet defaultOpen applyLabel={applyLabel} filterFieldCount={2}>
      <p>fields</p>
    </PortalFilterSortSheet>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a mouse in a narrow window keeps the popover", () => {
  it("does not render the phone bottom sheet at 900px on a Mac", () => {
    openFilter(MOUSE_IN_A_900PX_WINDOW);
    expect(document.querySelector('[data-slot="vaul-bottom-sheet"]')).toBeNull();
    const panel = document.querySelector('[data-slot="portal-filter-dropdown-panel"]');
    expect(panel?.getAttribute("data-surface")).toBe("popover");
  });

  it("gives a touch device the sheet", () => {
    openFilter(A_PHONE);
    expect(document.querySelector('[data-slot="vaul-bottom-sheet"]')).not.toBeNull();
  });
});

describe("the popover does not dim the list it is filtering", () => {
  it("leaves the page visible behind an anchored popover", () => {
    openFilter(MOUSE_IN_A_900PX_WINDOW);
    const backdrop = document.querySelector('[data-attr="portal-filter-dropdown-backdrop"]');
    // The layer stays, because it still catches the click that closes the
    // panel — it just stops painting over the rows you are filtering.
    expect(backdrop).not.toBeNull();
    expect(backdrop?.className).toContain("bg-transparent");
    expect(backdrop?.className).not.toContain("bg-black/20");
  });
});

describe("the count in the action follows the DRAFT, not the applied filters", () => {
  /**
   * The trap this exists for: while the panel is open the page's own filter
   * state is deliberately stale, so a count computed in the caller's render
   * reports the filters as they were BEFORE this edit. A label that reads the
   * pending values is the only honest one.
   */
  function DraftEcho() {
    const [, setDraft] = usePortalFilterDraft(
      [] as string[],
      () => {},
      [],
      PORTAL_FILTER_DRAFT_PROPERTY_FILTERS,
    );
    return (
      <button type="button" onClick={() => setDraft(["house-1"])}>
        pick a house
      </button>
    );
  }

  function CountLabel() {
    const draft = usePortalFilterDraftValues({
      [PORTAL_FILTER_DRAFT_PROPERTY_FILTERS]: [] as string[],
    });
    const rows = draft[PORTAL_FILTER_DRAFT_PROPERTY_FILTERS].length > 0 ? 1 : 7;
    return <>{filterApplyLabel(rows, "task")}</>;
  }

  it("re-reads the pending value as the panel is edited", async () => {
    stubMedia(MOUSE_IN_A_900PX_WINDOW);
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <PortalFilterSortSheet defaultOpen applyLabel={<CountLabel />} filterFieldCount={2}>
        <DraftEcho />
      </PortalFilterSortSheet>,
    );

    expect(screen.getByText("Show 7 tasks")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "pick a house" }));
    expect(screen.getByText("Show 1 task")).toBeTruthy();
  });
});

describe("the label itself", () => {
  it("says nothing rather than guessing when there is no count", () => {
    expect(filterApplyLabel(undefined, "task")).toBe("Save");
  });

  it("agrees with itself about one", () => {
    expect(filterApplyLabel(0, "task")).toBe("Show 0 tasks");
    expect(filterApplyLabel(1, "task")).toBe("Show 1 task");
    expect(filterApplyLabel(12, "task")).toBe("Show 12 tasks");
  });
});
