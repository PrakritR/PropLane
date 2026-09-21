import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The picker was built from browser-local caches while the server validated
 * against `manager_property_records`, so a listing that had not synced yet was
 * SELECTABLE and then rejected with "You can only assign properties you
 * manage." — an accusation of overreach for a sync gap the manager cannot see
 * and did not cause, naming no property, so a multi-select was unrecoverable
 * (PRP-210).
 *
 * The old invite-creation picker (in `pro-account-links-panel.tsx`, behind the
 * now-removed three-path chooser) fixed this by marking a not-yet-synced
 * option `disabled` with a "Still saving…" hint while keeping it visible. That
 * picker is gone: `docs/agents/co-manager-access.md` "The invite sheet
 * (`workspace-invite-sheet.tsx`) is the one manager invite surface". The new
 * sheet's house picker sources exclusively from `workspace.propertyIds` — the
 * server's own list (`loadWorkspaces`) — so a listing that has not synced to
 * `manager_property_records` yet is not a workspace house yet and cannot
 * appear as an option at all. The gap is closed by never offering the row,
 * rather than by offering-then-disabling it.
 */
const SHEET = readFileSync(
  join(process.cwd(), "src/components/portal/workspace-invite-sheet.tsx"),
  "utf8",
);
const PANEL = readFileSync(
  join(process.cwd(), "src/components/portal/pro-account-links-panel.tsx"),
  "utf8",
);
const CREATE_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/pro/account-links/route.ts"),
  "utf8",
);
const PATCH_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/pro/account-links/[inviteId]/route.ts"),
  "utf8",
);

describe("anything selectable in the invite sheet's house picker is acceptable to the server", () => {
  it("offers only the workspace's own server-synced houses", () => {
    expect(SHEET).toContain("workspace.propertyIds.map((id) => ({");
    expect(SHEET).toContain("houseOptions={houseOptions}");
  });

  it("never reaches into the browser-local pending-listing cache that caused the sync gap", () => {
    expect(SHEET).not.toContain("notYetSynced");
    expect(SHEET).not.toContain("readPendingManagerPropertiesForUser");
  });

  it("still marks the sync gap where `propertyChoices` is used for other pickers on the same panel", () => {
    // `propertyChoices` backs the panel's other property pickers (e.g. adding
    // a property to an existing team member) and still tags a not-yet-synced
    // listing so callers CAN gate on it, even though the invite sheet itself
    // no longer needs to.
    const fn = PANEL.slice(PANEL.indexOf("function propertyChoices("), PANEL.indexOf("function resolvePropertyLabel("));
    const live = fn.slice(fn.indexOf("for (const p of live)"), fn.indexOf("for (const r of pend)"));
    expect(live).not.toContain("notYetSynced");
    expect(fn.slice(fn.indexOf("for (const r of pend)"))).toContain("notYetSynced: true");
  });
});

describe("any rejection names the specific property", () => {
  it("the create route returns the offending ids", () => {
    expect(CREATE_ROUTE).toContain("unownedPropertyIds: ownership.unowned");
    expect(CREATE_ROUTE).not.toContain('"You can only assign properties you manage."');
  });

  it("the post-accept PATCH route does too", () => {
    expect(PATCH_ROUTE).toContain("unownedPropertyIds: ownership.unowned");
    expect(PATCH_ROUTE).not.toContain('"You can only assign properties you manage."');
  });

  it("the message stops accusing the manager of overreach", () => {
    // The cause is almost always a sync gap, so the copy names that and a
    // recovery, rather than implying they tried to assign someone else's.
    expect(CREATE_ROUTE).toContain("isn't on your account yet");
    expect(CREATE_ROUTE).toContain("Open Properties to let it finish saving");
  });
});
