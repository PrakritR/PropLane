// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider, usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { portalLabeledPrimarySpec } from "@/components/portal/portal-icon-action-spec";

vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => document.getElementById("portal-main-content"),
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

function LabeledPrimaryActions() {
  usePublishTitleActions(
    <>
      <button type="button" aria-label="Edit">
        <span className="sr-only">Edit</span>
      </button>
      {portalLabeledPrimarySpec({ id: "complete", label: "Complete", onClick: () => {} }).node}
    </>,
    true,
  );
  return null;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("768"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalDetailHeader - the one labeled primary stays a pill beside the 40px icon circles", () => {
  it("exempts a labeled primary from the circle sizing that every icon button gets", () => {
    render(
      <PortalTitleActionsProvider>
        <PortalDetailHeader title="Kitchen faucet drip" iconTitleActions />
        <LabeledPrimaryActions />
      </PortalTitleActionsProvider>,
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    const complete = screen.getByRole("button", { name: "Complete" });
    expect(complete.textContent).toBe("Complete");
    expect(complete.hasAttribute("data-labeled-primary")).toBe(true);
    expect(edit.hasAttribute("data-labeled-primary")).toBe(false);
    const host = complete.parentElement!;
    expect(host.contains(edit)).toBe(true);
    // Every size / shape override is scoped to "not a labeled primary", so the icon circles keep 40px
    // (`!size-9`) and the labeled button keeps its own h-9 / px-5 pill.
    for (const rule of ["!size-9", "!min-h-0", "!rounded-full", "!p-0"]) {
      expect(host.className).toContain(`[&_button:not([data-labeled-primary])]:${rule}`);
      expect(host.className).not.toContain(`[&_button]:${rule}`);
    }
    expect(complete.className).toContain("px-5");
  });
});
