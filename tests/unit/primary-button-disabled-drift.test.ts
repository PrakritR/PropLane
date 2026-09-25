import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Night UX sweep — Properties' and Tours' primary "+" buttons rendered in a
 * washed-out pastel blue that read as disabled, while the identical control
 * everywhere else (Applications, Leases, …) rendered solid brand blue.
 *
 * Root cause: `Button`'s `disabled:opacity-50` fired for the whole
 * transient window while a plan-tier / workspace-list / session flag was
 * still loading, indistinguishable from a permanently disabled control. Each
 * of these flows already has a click-time fallback for "not ready yet"
 * (`canOpenAdd()`'s toast-and-retry in Properties; the sibling actions in
 * Tours/Workspaces that never gated on the transient flag), so pre-disabling
 * the button was redundant and purely cosmetic damage. The real,
 * permanent gates (plan/property limits) must still disable the control.
 */
describe("primary add buttons are not disabled by a transient loading flag", () => {
  it("Properties: the header '+' and empty-state Create are not gated on the plan tier still loading", () => {
    const src = read("src/components/portal/pro-properties.tsx");
    expect(src).not.toMatch(/disabled=\{!skuLoaded\}/);
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
