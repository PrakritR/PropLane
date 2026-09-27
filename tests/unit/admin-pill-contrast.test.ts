import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const metrics = readFileSync(join(process.cwd(), "src/components/portal/portal-metrics.tsx"), "utf8");

/**
 * Night UX sweep — Admin Accounts' selected/unselected filter pills (Active/
 * Disabled, All tiers/Free/Pro/Business) were nearly indistinguishable in the
 * dark admin theme: the selected pill was only a faint low-opacity white
 * overlay on light text, both effectively "white-ish on near-black". Every
 * light-theme pill, and every other selected-state control in the product,
 * uses a solid brand-color fill with a high-contrast foreground
 * (`bg-primary text-primary-foreground`, see `ManagerPortalStatusPills`'
 * `activeTone="primary"`).
 *
 * `PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE` (portal-metrics.tsx) now applies that
 * same fill directly as real Tailwind utilities for dark theme, rather than
 * through the `.portal-status-pill-active` custom class name behind the same
 * `[html[data-theme=dark]_&]:` bracket-variant idiom, which observably never
 * painted (a live check found the rendered pill still at the old low-opacity
 * white regardless of that class's own CSS rule). The globals.css rule is
 * left pointed at the same tokens for whatever else references the class.
 */
describe("dark-theme selected toolbar pill uses the brand-fill tokens", () => {
  it("PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE fills dark theme with bg-primary/text-primary-foreground utilities", () => {
    const constant = metrics.slice(
      metrics.indexOf("export const PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE"),
      metrics.indexOf(";", metrics.indexOf("export const PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE")),
    );
    expect(constant).toContain("[html[data-theme=dark]_&]:bg-primary");
    expect(constant).toContain("[html[data-theme=dark]_&]:text-primary-foreground");
    expect(constant).not.toContain("portal-status-pill-active");
  });

  it("the underlying .portal-status-pill-active CSS rule (used elsewhere) also carries the same token pair", () => {
    const rule = css.slice(
      css.indexOf('[data-theme="dark"] .portal-status-pill-active'),
      css.indexOf("}", css.indexOf('[data-theme="dark"] .portal-status-pill-active')),
    );
    expect(rule).toContain("background-color: var(--primary)");
    expect(rule).toContain("color: var(--primary-foreground)");
    expect(rule).not.toContain("rgba(255, 255, 255, 0.16)");
  });
});
