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
 */
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

describe("anything selectable in the picker is acceptable to the server", () => {
  it("marks a not-yet-synced property and refuses to select it", () => {
    expect(PANEL).toContain("notYetSynced");
    expect(PANEL).toContain("disabled: Boolean(p.notYetSynced)");
  });

  it("keeps it visible rather than hiding a property the manager can see elsewhere", () => {
    expect(PANEL).toContain("Still saving — you can assign this once it finishes.");
  });

  it("only the pending (unsynced) source is marked — a live listing stays selectable", () => {
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
