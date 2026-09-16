import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/workspace-settings.tsx"), "utf8");

describe("workspace settings delete", () => {
  it("uses a danger icon action for non-default workspaces", () => {
    expect(src).toContain("data-attr=\"workspace-delete\"");
    expect(src).toContain("tone=\"danger\"");
    expect(src).toContain("!workspace.isDefault");
  });

  it("adds a dashed Delete this workspace row on empty extras", () => {
    expect(src).toContain("data-attr=\"workspace-delete-empty\"");
    expect(src).toContain("Delete this workspace");
    expect(src).toContain("It has no properties, so it will be removed now.");
  });

  it("opens Team in that workspace, not a Settings Vendors tab", () => {
    expect(src).toContain("href: \"/portal/profile?tab=team\"");
    expect(src).not.toContain("href: \"/portal/profile?tab=vendors\"");
    expect(src).not.toContain("workspace-manage-vendors");
  });
});
