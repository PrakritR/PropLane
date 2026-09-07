import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-184 #2 — the two status chips that measured under WCAG AA on the public
 * home mock ("Manager review" amber, "Screened"/"New" info) draw their colours
 * from the shared status tokens. The badge text is 10.5–11px, so the small-text
 * bar (4.5:1) applies. This computes the real ratio from globals.css so a
 * token nudge cannot quietly drop a chip below the line again.
 *
 * PRP-184 #3 — the dense equal-row destination nav used to shrink labels to
 * 8px to avoid overflow; the floor is now 11px with truncation instead.
 */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Every `--name: #hex` in the CSS block that starts at `selector`, first occurrence wins. */
function tokensIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (!(m[1]! in out)) out[m[1]!] = m[2]!;
  }
  return out;
}

const css = readFileSync("src/app/globals.css", "utf8");

describe("status chip tokens clear WCAG AA for small text (PRP-184 #2)", () => {
  for (const selector of ['[data-theme="light"]', '[data-surface="light"]']) {
    it(`${selector}: pending and approved foregrounds are ≥ 4.5:1 on their backgrounds`, () => {
      const t = tokensIn(css, selector);
      for (const pair of [
        ["status-pending-fg", "status-pending-bg"],
        ["status-approved-fg", "status-approved-bg"],
      ] as const) {
        const [fgName, bgName] = pair;
        expect(t[fgName], `${selector} ${fgName} must be a literal hex, not a var()`).toMatch(/^#/);
        expect(t[bgName], `${selector} ${bgName}`).toMatch(/^#/);
        const ratio = contrast(t[fgName]!, t[bgName]!);
        expect(ratio, `${selector} ${fgName} on ${bgName} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("dense destination nav labels never shrink below 11px (PRP-184 #3)", () => {
  it("uses an 11px floor and truncates instead of shrinking further", () => {
    const src = readFileSync("src/components/ui/destination-nav.tsx", "utf8");
    expect(src).not.toMatch(/clamp\(\s*[0-9](\.\d+)?px/);
    const m = src.match(/text-\[length:clamp\((\d+)px,[^)]*\)\]/);
    expect(m, "a clamp() label size on the dense equal row").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(11);
    const line = src.split("\n").find((l) => l.includes("clamp(11px"));
    expect(line).toContain("truncate");
  });
});
