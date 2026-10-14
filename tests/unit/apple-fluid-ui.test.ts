// Apple-fluid UI pass (studio plan apple-fluid-ui-1013): heading tracking, press states,
// sheet release by velocity and projection, spring tokens and reduced-motion handling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  projectSheetOffset,
  pushDragSample,
  releaseVelocity,
  resolveSheetRelease,
  scrimOpacityForOffset,
  SHEET_SAMPLE_COUNT,
  type DragSample,
} from "@/lib/ui/sheet-release";

const read = (path: string) => readFileSync(join(__dirname, "../../", path), "utf8");
const globalsCss = read("src/app/globals.css");
const tokensCss = read("src/components/ui/motion/tokens.css");

/** Samples at `perMs` px/ms ending at offset `endY`, 8ms apart. */
function drag(endY: number, perMs: number, count = 4): DragSample[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i * 8,
    y: endY - perMs * 8 * (count - 1 - i),
  }));
}

describe("heading tracking", () => {
  it("keeps the h1..h6 reset in the base layer so a tracking utility wins", () => {
    const layer = globalsCss.match(/@layer base\s*\{\s*h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*letter-spacing:\s*0;/);
    expect(layer).not.toBeNull();
    // ...and there is no second, unlayered copy of the rule.
    const unlayered = globalsCss.match(/^h1,\s*\nh2,[\s\S]*?letter-spacing:\s*0;/m);
    expect(unlayered).toBeNull();
  });

  it("tightens the display sizes through the theme", () => {
    expect(globalsCss).toMatch(/--text-3xl--letter-spacing:\s*-0\.02em/);
    expect(globalsCss).toMatch(/--text-4xl--letter-spacing:\s*-0\.025em/);
  });
});

describe("press states", () => {
  const button = read("src/components/ui/button.tsx");
  it("scales a pressed Button to 0.97 in 75ms and releases at 200ms", () => {
    expect(button).not.toContain("active:scale-[0.99]");
    expect(button.match(/active:scale-\[0\.97\] active:duration-75/g)?.length).toBe(6);
    expect(button).toContain("duration-200");
    // `scale` is its own property in Tailwind 4; it must be a transitioned one.
    expect(button).toContain("transition-[transform,scale,");
  });

  it("rows highlight instantly on press and browse cards press to .985", () => {
    const row = read("src/components/portal/portal-record-row.tsx");
    expect(row.match(/active:bg-\[rgba\(17,24,39,0\.07\)\] active:duration-75/g)?.length).toBe(2);
    expect(read("src/components/marketing/resident-housing-browse.tsx")).toContain("active:scale-[.985]");
  });
});

describe("sheet release", () => {
  it("keeps only the last four pointer samples", () => {
    let samples: DragSample[] = [];
    for (let i = 0; i < 9; i += 1) samples = pushDragSample(samples, { t: i, y: i });
    expect(samples).toHaveLength(SHEET_SAMPLE_COUNT);
    expect(samples[0].t).toBe(5);
  });

  it("measures velocity in px/s over the retained samples", () => {
    expect(releaseVelocity(drag(100, 1))).toBeCloseTo(1000, 5);
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([{ t: 1, y: 5 }])).toBe(0);
  });

  it("projects the resting offset with the 0.998 deceleration rate", () => {
    expect(projectSheetOffset(50, 0)).toBe(50);
    expect(projectSheetOffset(0, 1000)).toBeCloseTo(499, 5);
  });

  it("a fast flick dismisses even from a small offset", () => {
    const result = resolveSheetRelease({ samples: drag(30, 1.5), y: 30, height: 400 });
    expect(result.dismiss).toBe(true);
  });

  it("a slow release near the top settles", () => {
    const result = resolveSheetRelease({ samples: drag(60, 0.02), y: 60, height: 400 });
    expect(result.dismiss).toBe(false);
  });

  it("a slow drag past half the height dismisses", () => {
    const result = resolveSheetRelease({ samples: drag(260, 0.02), y: 260, height: 400 });
    expect(result.dismiss).toBe(true);
  });

  it("an upward flick never dismisses", () => {
    const result = resolveSheetRelease({ samples: drag(10, -1.5), y: 10, height: 400 });
    expect(result.dismiss).toBe(false);
  });

  it("holds the panel's CSS transition off while the finger is down", () => {
    // `.axis-assistant-sheet` transitions `transform`; left on, every pointermove would restart
    // it and the sheet would ease toward the finger instead of following it.
    const sheetDrag = read("src/components/ui/use-sheet-drag.ts");
    expect(sheetDrag).toMatch(/panel\.style\.transition = "none"/);
    expect(sheetDrag).toMatch(/transition: suppressTransition\(panel\)/);
    // Every way a drag can end puts it back: dismiss, no-op, reduced motion, settled spring.
    expect(sheetDrag.match(/restoreTransition\(panel, state\.transition\)/g)?.length).toBe(4);
  });

  it("ties the scrim to the drag", () => {
    expect(scrimOpacityForOffset(0, 400)).toBe(1);
    expect(scrimOpacityForOffset(100, 400)).toBeCloseTo(0.75, 5);
    expect(scrimOpacityForOffset(500, 400)).toBe(0);
    expect(scrimOpacityForOffset(10, 0)).toBe(1);
  });
});

describe("spring tokens", () => {
  it("defines the three linear() springs with cubic-bezier fallbacks", () => {
    expect(tokensCss).toMatch(/--spring-snappy:\s*linear\(0, 0\.162,/);
    expect(tokensCss).toMatch(/--spring-gentle:\s*linear\(0, 0\.162,/);
    expect(tokensCss).toMatch(/--spring-sheet:\s*linear\(0, 0\.172,/);
    expect(tokensCss).toMatch(/--spring-sheet:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
    expect(tokensCss).toContain("--spring-snappy-duration: 300ms");
  });

  it("no longer uses the 1.4 / 1.6 overshoot curves", () => {
    expect(tokensCss).not.toMatch(/cubic-bezier\(0\.34, 1\.4/);
    expect(tokensCss).not.toMatch(/cubic-bezier\(0\.3, 1\.6/);
  });

  it("enters modals and wizard steps by transition plus @starting-style", () => {
    expect(tokensCss).toMatch(/@starting-style\s*\{\s*\.motion-modal-panel-in/);
    expect(tokensCss).toMatch(/@starting-style\s*\{\s*\.motion-wiz-dir-fwd/);
    expect(tokensCss).not.toMatch(/animation:\s*motion-modal-in/);
  });

  it("sends a drawer out the way it came in", () => {
    expect(tokensCss).toMatch(/@keyframes motion-modal-exit-drawer\s*\{\s*to\s*\{\s*transform:\s*translateY\(100%\)/);
  });

  it("pads the Vaul drag handle to 44px", () => {
    expect(tokensCss).toMatch(/\[data-vaul-handle\]::before\s*\{[^}]*height:\s*2\.75rem/);
  });
});

describe("reduced motion", () => {
  const block = globalsCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.portal-shell \*,[\s\S]*?\n\}\n/)?.[0] ?? "";

  it("keeps opacity and colour transitions and drops transforms", () => {
    expect(block).toMatch(/transition-property:\s*opacity, background-color, border-color, color/);
    expect(block).not.toMatch(/transition-property:[^;]*transform/);
    expect(block).toMatch(/transition-duration:\s*150ms/);
    expect(block).not.toMatch(/transition-duration:\s*0\.01ms/);
  });

  it("cancels the press scale everywhere, and never the centring translate", () => {
    const reduced = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\n\s*:active\s*\{\s*scale:\s*none !important;\s*\}/);
    // `translate` positions `-translate-x-1/2` elements; resetting it on :active moves them.
    expect(globalsCss).not.toMatch(/:active\s*\{[^}]*translate:\s*none/);
    expect(tokensCss).not.toMatch(/:active\s*\{[^}]*translate:\s*none/);
  });

  it("collapses nothing to zero in the token file", () => {
    const reduced = tokensCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*\}/)?.[0] ?? "";
    expect(reduced).not.toMatch(/:\s*0ms/);
    expect(reduced).toContain("--motion-base: 150ms");
  });

  it("cross-fades entrances that portal outside the shell", () => {
    expect(tokensCss).toMatch(/\.motion-modal-panel-in,[\s\S]*?\.portal-assistant-rail\s*\{\s*transition-property:\s*opacity !important/);
  });

  it("honours reduced transparency and increased contrast on scrims and glass", () => {
    expect(tokensCss).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(tokensCss).toContain("@media (prefers-contrast: more)");
    expect(tokensCss).toMatch(/\.phone-sheet-scrim/);
  });
});
