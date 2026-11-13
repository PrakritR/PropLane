import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The Properties action waits for its plan read; unrelated add controls retain their own gates. */
describe("primary add buttons are not disabled by a transient loading flag", () => {
  it("Properties: the header waits for the plan tier", () => {
    const src = read("src/components/portal/pro-properties.tsx");
    expect(src).toMatch(/disabled=\{!skuLoaded\}/);
    expect(src).not.toMatch(/addPropertyDisabled=\{!skuLoaded\}/);
    // The real limit is still enforced at click time via canOpenAdd().
    expect(src).toContain("if (!skuLoaded) {");
    expect(src).toContain('showToast("Loading subscription…")');
  });

  it("Tours: none of the three Add/Schedule tour actions are gated on authReady, only on having a listed property", () => {
    const src = read("src/components/portal/pro-tours.tsx");
    expect(src).not.toMatch(/disabled=\{!authReady \|\| scopedPropertyIds\.length === 0\}/);
    expect(src).not.toMatch(/disabled: !authReady \|\| scopedPropertyIds\.length === 0,/);
    // The real "no property yet" gate survives everywhere it was already applied.
    const authReadyGateCount = (src.match(/scopedPropertyIds\.length === 0/g) ?? []).length;
    expect(authReadyGateCount).toBeGreaterThanOrEqual(3);
  });

  it("Workspaces settings: the '+' is gated on the plan cap, not on the workspace list still loading", () => {
    const src = read("src/components/portal/workspace-settings.tsx");
    expect(src).not.toMatch(/disabled=\{atWorkspaceCap \|\| ctx\.loading\}/);
    expect(src).toMatch(/disabled=\{atWorkspaceCap\}/);
  });
});
