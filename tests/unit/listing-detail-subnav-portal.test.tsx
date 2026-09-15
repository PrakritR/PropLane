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
  it("renders all section tabs from the start so labels are not center-clipped", () => {
    render(<ListingStickySubnav mode="portal" appearance="portal" />);

    const list = document.querySelector("[data-listing-subnav] ul");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("grid");
    expect(list?.className).toContain("w-full");
    expect(document.querySelectorAll('[data-attr="listing-section-tab"]').length).toBe(7);
  });

  it("uses compact equal-width tabs in pinned listing preview shell", () => {
    render(<ListingStickySubnav mode="modal" pinned appearance="portal" />);

    const list = document.querySelector("[data-listing-subnav] ul");
    expect(list?.className).toContain("grid");
    expect(screen.getByRole("button", { name: "Rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Location" })).toBeTruthy();
  });
});
