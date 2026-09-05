import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * At the plan cap, ADD PROPERTY was enabled, clickable and inert: no modal, no
 * navigation, only a toast that named an upgrade without going there (PRP-225).
 * A dead primary action reads as a broken product rather than a limit, and it
 * wastes the highest-intent moment there is — the manager clicked ADD BECAUSE
 * they want another property.
 *
 * AGENTS.md already states the rule for the sidebar's `upsell` nav lock: the
 * locked control stays live precisely because its destination is the only route
 * to upgrade, and "rendering it as a <span> deletes a revenue path". This is
 * that rule applied to the ADD row.
 */
const SOURCE = readFileSync(join(process.cwd(), "src/components/portal/pro-properties.tsx"), "utf8");

function tryOpenAddBody(): string {
  const start = SOURCE.indexOf("const tryOpenAdd = () => {");
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("\n  };", start));
}

describe("ADD PROPERTY at the plan limit", () => {
  it("routes to the plans page instead of doing nothing", () => {
    const body = tryOpenAddBody();
    expect(body).toContain("router.push(MANAGER_PLAN_PORTAL_URL)");
  });

  it("still refuses to open the wizard", () => {
    const body = tryOpenAddBody();
    const limitBranch = body.slice(body.indexOf("if (atPropertyLimit)"));
    expect(limitBranch).toContain("return;");
    expect(limitBranch.slice(0, limitBranch.indexOf("return;"))).not.toContain("setWizardOpen(true)");
  });

  it("does not steer to an external purchase inside the native app", () => {
    // The app store forbids it; `omitUpgradeCta` already encodes that for the
    // message, and the navigation must respect the same boundary.
    const body = tryOpenAddBody();
    expect(body).toContain("if (!isNativeRuntimeSync()) router.push(MANAGER_PLAN_PORTAL_URL)");
    expect(body).toContain("omitUpgradeCta: isNativeRuntimeSync()");
  });

  it("still tells the manager why, in words", () => {
    expect(tryOpenAddBody()).toContain("showToast(managerPropertyLimitMessage(");
  });

  it("keeps the ADD row live rather than disabling it at the cap", () => {
    // Disabling is the other way to delete the upgrade path.
    expect(SOURCE).toContain("addPropertyDisabled={!skuLoaded}");
    expect(SOURCE).not.toContain("addPropertyDisabled={atPropertyLimit");
  });
});

/**
 * Empty property stages show only the ADD row — no empty-state card.
 */
describe("empty property stages", () => {
  const PANEL = readFileSync(
    join(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"),
    "utf8",
  );

  it("renders only the ADD row when a stage has no properties", () => {
    expect(PANEL).not.toContain("PortalEmptyState");
    expect(PANEL).not.toContain("PROPERTY_STAGE_EMPTY_COPY");
    expect(PANEL).toContain("renderAddPropertyRow()");
    expect(PANEL).toContain("PORTAL_LIST_PAGE_BODY");
  });
});
