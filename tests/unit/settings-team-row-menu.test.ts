import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const blocks = readFileSync(resolve("src/components/portal/pro-team-blocks.tsx"), "utf8");
const panel = readFileSync(resolve("src/components/portal/pro-account-links-panel.tsx"), "utf8");

describe("Settings Team row actions", () => {
  it("puts Edit, Permissions, and Remove in a far-right ⋯", () => {
    expect(blocks).toContain('label: "Edit"');
    expect(blocks).toContain('label: "Permissions"');
    expect(blocks).toContain('label: "Remove"');
    expect(blocks).toContain('data-attr="team-member-actions"');
    expect(blocks).not.toContain("onAccess");
  });

  it("publishes Invite to the Team title instead of a second Link control", () => {
    expect(panel).toContain('data-attr="co-manager-invite-top"');
    expect(panel).toContain("usePublishTitleActions");
    expect(panel).toMatch(/\n\s*Invite\n\s*<\/Button>/);
    expect(panel).not.toContain("PortalPrimaryIconAction");
    expect(panel).not.toContain('data-attr="team-invite-link-create"');
  });
});
