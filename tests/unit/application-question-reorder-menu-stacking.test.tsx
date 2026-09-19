// @vitest-environment jsdom
//
// The reorder menu sits inside the full-page question workspace, which is a Modal
// stacked at z-[90]/z-[91]. Radix portals the menu to document.body, so at the
// default z-50 it painted BEHIND the workspace: visible, but every click landed on
// the row on top of it, and reordering by mouse silently did nothing. Alt+Arrow
// reorder never routes through this menu, which is exactly why the behavioural
// tests passed while the mouse path was broken in a real browser. This pins the
// stacking so the menu cannot slip back under the workspace.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const builderSource = readFileSync(
  resolve(process.cwd(), "src/components/portal/application-form-builder.tsx"),
  "utf8",
);
const modalSource = readFileSync(resolve(process.cwd(), "src/components/ui/modal.tsx"), "utf8");

/** Highest `z-[N]` in a source file, so the assertion tracks the real modal stack. */
function highestArbitraryZ(source: string): number {
  const found = [...source.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}

describe("reorder menu stacking inside the full-page workspace", () => {
  it("lifts both the menu and its submenu above the modal stack", () => {
    const menuZ = [...builderSource.matchAll(/DropdownMenu(?:Sub)?Content[^>]*className="z-\[(\d+)\]"/g)].map(
      (m) => Number(m[1]),
    );
    // Both the menu and the "Move to section" submenu must be lifted; lifting only
    // one leaves the submenu unclickable, which is how it originally presented.
    expect(menuZ).toHaveLength(2);

    const modalZ = highestArbitraryZ(modalSource);
    const overlayZ = 80;
    expect(modalZ).toBeGreaterThan(0);
    for (const z of menuZ) {
      expect(z).toBeGreaterThan(modalZ);
      expect(z).toBeGreaterThan(overlayZ);
    }
  });

  it("does not rely on the default z-50, which is below the workspace", () => {
    const modalZ = highestArbitraryZ(modalSource);
    expect(modalZ).toBeGreaterThan(50);
  });
});
