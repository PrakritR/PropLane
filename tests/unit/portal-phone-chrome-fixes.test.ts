import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tabOverflowMask } from "@/components/ui/destination-nav";
import { shouldRenderShowAllSectionsButton } from "@/components/portal/portal-sidebar";

const read = (p: string) => readFileSync(p, "utf8");

describe("Show all sections overlay", () => {
  it("renders only when the bar has no More tab", () => {
    expect(shouldRenderShowAllSectionsButton({ hasMoreTab: false })).toBe(true);
    expect(shouldRenderShowAllSectionsButton({ hasMoreTab: true })).toBe(false);
  });
  it("sidebar gates the button on the helper", () => {
    expect(read("src/components/portal/portal-sidebar.tsx")).toContain("shouldRenderShowAllSectionsButton({ hasMoreTab: showMoreTab })");
  });
});

describe("tab strip overflow cue", () => {
  it("fades the right edge while more is hidden, the left once scrolled, both mid-way, none when it fits", () => {
    expect(tabOverflowMask(false, false)).toBeUndefined();
    expect(tabOverflowMask(false, true)).toContain("to right, black");
    expect(tabOverflowMask(true, false)).toContain("to left");
    expect(tabOverflowMask(true, true)).toContain("transparent, black 28px");
  });
});

describe("stat strip on phones", () => {
  it("is two columns below md and auto-fit from md up", () => {
    const src = read("src/components/portal/portal-stat-strip.tsx");
    expect(src).toContain("max-md:grid-cols-2");
    expect(src).toContain("md:[grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]");
  });
});

describe("More badge inset", () => {
  it("is anchored to the icon centre, not the tab edge", () => {
    const src = read("src/components/portal/portal-native-more-sheet.tsx");
    expect(src).toContain("absolute -top-1 left-1/2 ml-1.5");
  });
});

describe("compose To field tap targets", () => {
  it("is at least 44px on phones", () => {
    const src = read("src/components/portal/pro-communication-compose-modal.tsx");
    expect(src).toContain("max-md:min-h-11");
    expect(src).toContain("max-md:h-11 max-md:w-11");
  });
});
