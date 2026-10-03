import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const blocks = readFileSync(resolve("src/components/portal/pro-team-blocks.tsx"), "utf8");
const panel = readFileSync(resolve("src/components/portal/pro-account-links-panel.tsx"), "utf8");

describe("Settings Team row actions", () => {
  it("puts Permissions, Transfer ownership and Remove in the far-right menu", () => {
    expect(blocks).toContain('label: "Permissions"');
    expect(blocks).toContain('label: "Remove"');
    expect(blocks).toContain('dataAttr: "team-member-edit"');
    expect(blocks).toContain('dataAttr: "team-member-disconnect"');
    expect(blocks).toContain('data-attr="team-member-actions"');
    // The row menu keeps the liquid default (dropdown-menu-callers-use-default.test.ts, c82a2eefe):
    // only the in-modal question menu opts out of the backdrop.
    expect(blocks).toContain('<DropdownMenuContent align="end" aria-label={`Actions for ${label}`} data-attr="team-member-actions-menu">');
    expect(blocks).not.toContain("backdrop={false}");
  });

  it("labels the ⋯ menu's ownership-transfer item exactly \"Transfer ownership\" (workspace transfer, no trailing ellipsis)", () => {
    expect(blocks).toContain('label: "Transfer ownership", onSelect: m.onTransfer, dataAttr: "team-member-transfer"');
    expect(blocks).not.toContain("Transfer ownership…");
    expect(panel).not.toContain("Transfer ownership…");
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
    expect(panel).toContain("UserPlus");
    expect(panel).toContain('label="Invite"');
    expect(panel).not.toContain('data-attr="team-invite-link-create"');
  });
});
