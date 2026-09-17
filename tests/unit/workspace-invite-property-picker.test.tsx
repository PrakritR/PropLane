import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("workspace invite property picker", () => {
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");

  it("shows the property picker on every invite path, not only after PropLane ID lookup", () => {
    expect(PANEL).toContain('dataAttr="co-manager-invite-properties"');
    expect(PANEL).toContain("handleLinkPropertySelectionChange(ids)");
    expect(PANEL).toContain("Default every house currently in this workspace");
    expect(PANEL).not.toContain("No properties available for team invites yet.");
  });

  it("scopes the picker to the workspace whose Invite was pressed", () => {
    expect(PANEL).toContain("for (const id of pickerPropertyIds)");
    expect(PANEL).toContain("openLinkModal(workspace.id)");
  });
});
