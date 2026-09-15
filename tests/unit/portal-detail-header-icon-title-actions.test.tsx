// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider, usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";

vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => document.getElementById("portal-main-content"),
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

/** Pretend the viewport is on one side of Tailwind's `md`. */
function stubViewport(mdUp: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("768") ? mdUp : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function DraftActions() {
  usePublishTitleActions(
    <>
      <button type="button" aria-label="Continue editing">
        <span className="max-md:sr-only">Continue editing</span>
      </button>
      <button type="button" aria-label="Delete draft">
        <span className="max-md:sr-only">Delete draft</span>
      </button>
    </>,
    true,
  );
  return null;
}

function renderHeader(iconTitleActions: boolean) {
  return render(
    <PortalTitleActionsProvider>
      <PortalDetailHeader title="Property · New listing" iconTitleActions={iconTitleActions} />
      <DraftActions />
    </PortalTitleActionsProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalDetailHeader — draft actions as icons in the title row", () => {
  it("puts the published actions in the title row below md and renders no band beneath", () => {
    stubViewport(false);
    renderHeader(true);

    const header = document.querySelector("header.portal-detail-header")!;
    const titleRow = header.firstElementChild!;
    const band = header.lastElementChild!;

    const edit = screen.getByRole("button", { name: "Continue editing" });
    const del = screen.getByRole("button", { name: "Delete draft" });
    expect(titleRow.contains(edit)).toBe(true);
    expect(titleRow.contains(del)).toBe(true);
    expect(band.contains(edit)).toBe(false);
    expect(band.className).toContain("hidden");
    // exactly one copy of each action for a screen reader
    expect(screen.getAllByRole("button", { name: "Continue editing" }).length).toBe(1);
  });

  it("keeps the worded band below md when the flag is off (listed properties)", () => {
    stubViewport(false);
    renderHeader(false);

    const header = document.querySelector("header.portal-detail-header")!;
    const band = header.lastElementChild!;
    expect(band.contains(screen.getByRole("button", { name: "Delete draft" }))).toBe(true);
    expect(band.className).toContain("flex");
  });

  it("holds the same icon buttons in the title row at md and up", () => {
    stubViewport(true);
    renderHeader(true);

    const header = document.querySelector("header.portal-detail-header")!;
    const titleRow = header.firstElementChild!;
    const edit = screen.getByRole("button", { name: "Continue editing" });
    expect(titleRow.contains(edit)).toBe(true);
    expect(edit.parentElement?.className).toContain("!size-9");
    expect(screen.getAllByRole("button", { name: "Delete draft" }).length).toBe(1);
  });
});

describe("ListingStickySubnav — inside a pinned-chrome scroll body", () => {
  it("scrolls the body it lives in, not the locked portal main, and sticks to the body's top edge", () => {
    const main = document.createElement("div");
    main.id = "portal-main-content";
    const body = document.createElement("div");
    body.className = "portal-list-page-scroll";
    main.appendChild(body);
    document.body.appendChild(main);

    const bodyScrollTo = vi.fn();
    const mainScrollTo = vi.fn();
    Object.defineProperty(body, "scrollTo", { value: bodyScrollTo });
    Object.defineProperty(main, "scrollTo", { value: mainScrollTo });

    render(
      <>
        <ListingStickySubnav mode="portal" appearance="portal" />
        <section id="amenities" />
      </>,
      { container: body },
    );

    const nav = body.querySelector<HTMLElement>("[data-listing-subnav]")!;
    expect(nav.style.top).toBe("0px");

    screen.getByRole("button", { name: "Amenities" }).click();
    expect(bodyScrollTo).toHaveBeenCalledTimes(1);
    expect(mainScrollTo).not.toHaveBeenCalled();

    main.remove();
  });
});
