// @vitest-environment jsdom
//
// Proof finding (LOW): the PropLane vendors Filter toggle used lucide's
// `Filter` icon (internally "Funnel"), which is outside
// `PORTAL_LIST_BAND_ALLOWED_ICONS` in portal-list-control-stack.tsx and
// logs a console error on every render via `assertPortalListBandContract`.
// Fixed by switching to `SlidersHorizontal`, the documented Filter glyph
// (docs/portal-list-section-layout.md). This proves the fix against the
// REAL guard, not a source-string match, and includes a negative control
// (the old icon) to prove the test would have caught the original bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Filter, SlidersHorizontal } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

describe("PropLane vendors Filter icon — stays inside the list-band icon vocabulary", () => {
  afterEach(cleanup);

  it("SlidersHorizontal (the fix) never trips the list-band icon guard", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <PortalListControlStack
        variant="command"
        actions={<PortalIconAction label="Filter" icon={SlidersHorizontal} data-attr="vendor-directory-filter-toggle" />}
      />,
    );
    const violations = spy.mock.calls.filter((call) => String(call[0]).includes("outside the documented list-band vocabulary"));
    expect(violations).toHaveLength(0);
    spy.mockRestore();
  });

  it("negative control: the original Filter/Funnel icon DOES trip the guard (proves this test would have caught the bug)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <PortalListControlStack
        variant="command"
        actions={<PortalIconAction label="Filter" icon={Filter} data-attr="vendor-directory-filter-toggle" />}
      />,
    );
    const violations = spy.mock.calls.filter((call) => String(call[0]).includes("outside the documented list-band vocabulary"));
    expect(violations.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
