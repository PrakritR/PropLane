// @vitest-environment jsdom
//
// STD-7: list-header Filter actions use lucide Filter (funnel), matching
// manager Outgoing payments and the studio replica — not SlidersHorizontal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Filter, SlidersHorizontal } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

describe("PropLane vendors Filter icon — stays inside the list-band icon vocabulary", () => {
  afterEach(cleanup);

  it("Filter funnel (the studio glyph) never trips the list-band icon guard", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <PortalListControlStack
        variant="command"
        actions={<PortalIconAction label="Filter" icon={Filter} data-attr="vendor-directory-filter-toggle" />}
      />,
    );
    const violations = spy.mock.calls.filter((call) => String(call[0]).includes("outside the documented list-band vocabulary"));
    expect(violations).toHaveLength(0);
    spy.mockRestore();
  });

  it("negative control: SlidersHorizontal is no longer in the list-band vocabulary", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <PortalListControlStack
        variant="command"
        actions={<PortalIconAction label="Filter" icon={SlidersHorizontal} data-attr="vendor-directory-filter-toggle" />}
      />,
    );
    const violations = spy.mock.calls.filter((call) => String(call[0]).includes("outside the documented list-band vocabulary"));
    expect(violations.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
