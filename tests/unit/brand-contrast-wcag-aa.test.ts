import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Relative luminance for sRGB hex (#rrggbb). */
function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("brand colour WCAG AA for small text (PRP-392)", () => {
  const css = readFileSync(`${process.cwd()}/src/app/globals.css`, "utf8");

  it("keeps dark filled primary deep enough for white labels", () => {
    // Dark theme maps --primary to --pl-purple-deep (not the soft lavender).
    expect(css).toMatch(/\[data-theme="dark"\][\s\S]*?--primary:\s*var\(--pl-purple-deep\)/);
    expect(css).toMatch(/\[data-theme="dark"\][\s\S]*?--btn-primary:\s*var\(--pl-purple-deep\)/);
    expect(contrastRatio("#ffffff", "#5b5fd4")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps light brand blue deep enough for selected tab labels on white", () => {
    expect(css).toMatch(/--pl-blue:\s*#2863f0/);
    expect(contrastRatio("#2863f0", "#fefefe")).toBeGreaterThanOrEqual(4.5);
  });
});
