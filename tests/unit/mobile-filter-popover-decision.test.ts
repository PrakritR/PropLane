// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolveMobileFilterPopover } from "@/components/portal/portal-filter-sort-sheet";

describe("phone filter surfaces", () => {
  it.each(["inline", "panel", "dropdown"] as const)("keeps %s filters anchored even with many fields or little space", (desktopPresentation) => {
    expect(resolveMobileFilterPopover({
      trigger: null,
      desktopPresentation,
      compactPanel: false,
      filterFieldCount: 8,
      hasExtraModalContent: true,
      insets: { bottom: 34, bottomNav: 64 },
    })).toBe(true);
  });
});
