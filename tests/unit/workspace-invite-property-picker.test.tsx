import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("workspace invite property picker", () => {
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");
  const SHEET = read("src/components/portal/workspace-invite-sheet.tsx");

  it("shows a house picker for 'Only selected houses', defaulting to every house in the workspace", () => {
    expect(SHEET).toContain('selectedHousesDataAttr="workspace-invite-selected-houses"');
    expect(SHEET).toContain('houseScope === "all" ? workspace.propertyIds : selectedHouseIds');
    expect(SHEET).not.toContain("No properties available for team invites yet.");
  });

  it("scopes the sheet — and its house picker — to the workspace whose Invite was pressed", () => {
    expect(PANEL).toContain("openLinkModal(workspace.id)");
    expect(PANEL).toContain("workspace={inviteWorkspace}");
    expect(SHEET).toContain("workspace.propertyIds.map((id) => ({");
  });
});
