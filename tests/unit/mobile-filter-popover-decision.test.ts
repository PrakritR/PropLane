// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolveMobileFilterPopover } from "@/components/portal/portal-filter-sort-sheet";

describe("phone filter surfaces", () => {
  it.each(["inline", "panel", "dropdown"] as const)("opens %s filters as a bottom sheet on a phone, whatever the field count or space", (desktopPresentation) => {
    expect(resolveMobileFilterPopover({
      trigger: null,
      desktopPresentation,
      compactPanel: false,
      filterFieldCount: 8,
      hasExtraModalContent: true,
      insets: { bottom: 34, bottomNav: 64 },
    })).toBe(false);
  });
});
