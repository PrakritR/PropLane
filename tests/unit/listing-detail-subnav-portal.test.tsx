// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";

vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

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

describe("ListingStickySubnav — portal property preview", () => {
  it("draws the standard underline command tabs (a scrolling row, no boxed grid) with every section", () => {
    render(<ListingStickySubnav mode="portal" appearance="portal" />);

    const list = document.querySelector("[data-listing-subnav] ul");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("overflow-x-auto");
    expect(list?.className).not.toContain("grid");
    expect(document.querySelectorAll('[data-attr="listing-section-tab"]').length).toBe(7);

    const tabs = [...document.querySelectorAll<HTMLElement>('[data-attr="listing-section-tab"]')];
    // underline, not a card: every tab owns a bottom border, the active one in the brand colour
    for (const tab of tabs) {
      expect(tab.className).toContain("border-b-2");
      expect(tab.className).not.toContain("ring-1");
    }
    const active = tabs.find((tab) => tab.getAttribute("aria-current") === "true");
    expect(active?.className).toContain("border-primary");
    // the strip carries no boxed padding of its own
    expect(document.querySelector("[data-listing-subnav]")?.className).toContain("py-0");
  });

  it("uses the same underline tabs in the pinned listing preview shell", () => {
    render(<ListingStickySubnav mode="modal" pinned appearance="portal" />);

    const list = document.querySelector("[data-listing-subnav] ul");
    expect(list?.className).toContain("overflow-x-auto");
    expect(screen.getByRole("button", { name: "Rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Location" })).toBeTruthy();
  });

  it("keeps the marketing pill tabs and the end-aligned chrome untouched", () => {
    render(<ListingStickySubnav mode="page" />);
    const marketingTab = document.querySelector<HTMLElement>('[data-attr="listing-section-tab"]');
    expect(marketingTab?.className).not.toContain("border-b-2");
    cleanup();
    render(<ListingStickySubnav mode="portal" appearance="portal" align="end" />);
    const endTab = document.querySelector<HTMLElement>('[data-attr="listing-section-tab"]');
    expect(endTab?.className).not.toContain("border-b-2");
  });
});
