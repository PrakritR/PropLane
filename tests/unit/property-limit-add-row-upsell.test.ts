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

/** The plan / sign-in / limit guard the ＋ (Create) goes through before anything opens. */
function tryOpenAddBody(): string {
  const start = SOURCE.indexOf("const canOpenAdd = (): boolean => {");
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("\n  };", start));
}

/** The plan-limit confirm dialog itself (`PortalDialog open={planLimitDialogOpen}`). */
function planLimitDialogBody(): string {
  const start = SOURCE.indexOf("open={planLimitDialogOpen}");
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("</PortalDialog>", start));
}

describe("ADD PROPERTY at the plan limit", () => {
  it("opens a confirm instead of doing nothing", () => {
    // A gate is a dialog, not a silent redirect away from the highest-intent
    // click there is (PLAN-0920-1058 "1d · The pop-up").
    const body = tryOpenAddBody();
    expect(body).toContain("setPlanLimitDialogOpen(true)");
  });

  it("the confirm's Upgrade action is what navigates to the plans page", () => {
    const dialogBody = planLimitDialogBody();
    expect(dialogBody).toContain('label: "Upgrade"');
    expect(dialogBody).toContain("router.push(MANAGER_PLAN_PORTAL_URL)");
    expect(dialogBody).toContain('secondaryAction={{ label: "Cancel"');
  });

  it("still refuses to open the wizard", () => {
    const body = tryOpenAddBody();
    const limitBranch = body.slice(body.indexOf("if (atPropertyLimit)"));
    expect(limitBranch).toContain("return false;");
    expect(limitBranch.slice(0, limitBranch.indexOf("return false;"))).not.toContain("setWizardOpen(true)");
    // Create goes through the guard before anything opens; the file import
    // lives inside the editor it opens, so there is no second entry to guard.
    expect(SOURCE).toMatch(/const tryOpenAdd = \(\) => \{\s+if \(!canOpenAdd\(\)\) return;/);
    expect(SOURCE).not.toContain("tryOpenImport");
  });

  it("does not steer to an external purchase inside the native app — no auto-redirect either way", () => {
    // The app store forbids it; `omitUpgradeCta` already encodes that for the
    // message. Native gets the message alone (no dialog, no navigation);
    // everywhere else the confirm opens, but nothing navigates on its own —
    // only the dialog's own Upgrade click does.
    const body = tryOpenAddBody();
    const limitBranch = body.slice(body.indexOf("if (atPropertyLimit)"));
    expect(limitBranch).toContain("if (isNativeRuntimeSync())");
    expect(limitBranch).toContain("showToast(managerPropertyLimitMessage(skuTier, { omitUpgradeCta: true }))");
    expect(limitBranch).toContain("setPlanLimitDialogOpen(true)");
    expect(limitBranch).not.toContain("router.push");
  });

  it("still tells the manager why, in words", () => {
    expect(tryOpenAddBody()).toContain("showToast(managerPropertyLimitMessage(");
  });

  it("keeps the ADD row live rather than disabling it at the cap or while the plan tier is still loading", () => {
    // Disabling is the other way to delete the upgrade path. The plan tier
    // still loading is the same story: `canOpenAdd()` already toasts and
    // queues a retry for that window (night UX sweep — a pre-disabled
    // button there was indistinguishable from permanently broken).
    expect(SOURCE).toContain("addPropertyDisabled={false}");
    expect(SOURCE).not.toContain("addPropertyDisabled={atPropertyLimit");
    expect(SOURCE).not.toContain("addPropertyDisabled={!skuLoaded}");
  });
});

/**
 * Empty property stages show the titled empty card (§15) — what the stage
 * holds, the stage that has rows, and Add property — never a bare dashed box
 * and never the old PortalEmptyState copy table.
 */
describe("empty property stages", () => {
  const PANEL = readFileSync(
    join(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"),
    "utf8",
  );

  it("renders the empty card when a stage has no properties", () => {
    expect(PANEL).not.toContain("PortalEmptyState");
    expect(PANEL).not.toContain("PROPERTY_STAGE_EMPTY_COPY");
    expect(PANEL).not.toContain("PortalListAddRow");
    expect(PANEL).toContain("renderEmptyState()");
    expect(PANEL).toContain("PORTAL_LIST_PAGE_BODY");
  });
});
