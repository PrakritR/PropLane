import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/workspace-settings.tsx"), "utf8");

describe("workspace settings delete", () => {
  it("offers one danger icon action on every owned workspace, the default one included", () => {
    expect(src).toContain("data-attr=\"workspace-delete\"");
    expect(src).toContain("tone=\"danger\"");
    expect(src).not.toContain("!workspace.isDefault");
    expect(src).not.toContain("workspace-delete-empty");
    expect(src).not.toContain("Delete this workspace");
  });

  it("deletes an empty workspace on a plain confirm and a full one through the move dialog", () => {
    expect(src).toContain("It has no properties, so it will be removed now.");
    expect(src).toContain("data-attr=\"workspace-delete-move-to\"");
    expect(src).toContain("Move and delete");
    expect(src).toContain("data-attr=\"workspace-delete-add-first\"");
    expect(src).not.toContain("Move its properties to another workspace first.");
  });

  it("renders the team inside each workspace card, never as a separate Team section or tab", () => {
    expect(src).toContain("renderWorkspaces");
    expect(src).toContain("team.section(workspace)");
    expect(src).not.toContain("id=\"workspace-team\"");
    expect(src).not.toContain("#workspace-team");
    expect(src).not.toContain("Team on this workspace");
    expect(src).not.toContain("workspace-manage-team");
    expect(src).not.toContain("href: \"/portal/profile?tab=team\"");
    expect(src).not.toContain("href: \"/portal/profile?tab=vendors\"");
    expect(src).not.toContain("workspace-manage-vendors");
  });
});
