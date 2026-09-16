import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const blocks = readFileSync(resolve("src/components/portal/pro-team-blocks.tsx"), "utf8");
const panel = readFileSync(resolve("src/components/portal/pro-account-links-panel.tsx"), "utf8");

describe("Settings Team row actions", () => {
  it("puts Edit and Disconnect in a far-right ⋯ — Permissions opened the same page as Edit, and Remove is now Disconnect", () => {
    expect(blocks).toContain('label: "Edit"');
    expect(blocks).toContain('label: "Disconnect"');
    expect(blocks).toContain('dataAttr: "team-member-disconnect"');
    expect(blocks).not.toContain('label: "Permissions"');
    expect(blocks).not.toContain('label: "Remove"');
    expect(blocks).toContain('data-attr="team-member-actions"');
    expect(blocks).not.toContain("onAccess");
    expect(blocks).not.toContain("onPermissions");
  });

  it("says Disconnect, never Remove, wherever a team member is taken off the team", () => {
    expect(panel).toContain('title="Disconnect team member — notification preview"');
    expect(panel).toContain('confirmLabel="Disconnect & send message"');
    expect(panel).not.toContain("Remove team link");
    expect(panel).not.toContain("Team link removed");
    expect(panel).not.toContain('"Link removed."');
  });

  it("renders one Managers & permissions section per workspace card, with that card's Invite", () => {
    expect(panel).toContain("renderWorkspaces");
    expect(panel).toContain("grantBelongsToWorkspace");
    expect(panel).toContain('data-attr="workspace-team-invite"');
    expect(panel).toContain("openLinkModal(workspace.id)");
  });

  it("publishes Invite to the Team title instead of a second Link control", () => {
    expect(panel).toContain('data-attr="co-manager-invite-top"');
    expect(panel).toContain("usePublishTitleActions");
    expect(panel).toMatch(/\n\s*Invite\n\s*<\/Button>/);
    expect(panel).not.toContain("PortalPrimaryIconAction");
    expect(panel).not.toContain('data-attr="team-invite-link-create"');
  });
});
