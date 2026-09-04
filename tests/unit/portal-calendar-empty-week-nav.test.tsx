// @vitest-environment jsdom
//
// PRP-224 — a manager with NO properties must still get the week navigation.
//
// The reported symptom was an e2e failure: no "Previous week" button on the calendar when the
// portfolio is empty. The manager calendar renders `PortalCalendarPanels` with
// `compactAvailability`, and that flag is exactly what lets the panel skip its
// "nothing to show" early return — so the empty state is supposed to be a real week grid
// carrying the message, not a bare sentence.
//
// Nothing enforced that. The early return is one `&& !compactAvailability` away from
// swallowing the whole toolbar, and the only coverage was an e2e test that needs a
// zero-property account to reach the case at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

const EMPTY_PORTFOLIO_MESSAGE = "No houses found for this manager account yet.";

beforeEach(() => {
  window.sessionStorage?.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Exactly what the manager calendar passes once the property load settles on zero houses. */
function renderEmptyPortfolioCalendar() {
  return render(
    <AppUiProvider>
    <PortalCalendarPanels
      storageKey={null}
      calendarRefreshSignal={0}
      bareSurface
      compactAvailability
      unavailableMessage={EMPTY_PORTFOLIO_MESSAGE}
      availabilityHeading="Tour availability"
    />
    </AppUiProvider>,
  );
}

describe("manager calendar with an empty portfolio", () => {
  it("still exposes week navigation", () => {
    renderEmptyPortfolioCalendar();

    expect(screen.getAllByRole("button", { name: "Previous week" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Next week" }).length).toBeGreaterThan(0);
  });

  it("does not collapse to the bare unavailable sentence", () => {
    const { container } = renderEmptyPortfolioCalendar();

    // The early return renders a single <p> and nothing else; the week grid is much more.
    expect(container.querySelectorAll("button").length).toBeGreaterThan(2);
  });
});
