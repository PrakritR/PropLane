import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/portal-profile-client.tsx"), "utf8");

function groupFor(id: string): string | null {
  const block = src.split(`id: "${id}"`)[1];
  if (!block) return null;
  const match = block.match(/group:\s*"(Workspace|Account)"/);
  return match?.[1] ?? null;
}

describe("settings account vs workspace groups", () => {
  it("keeps person settings on Account", () => {
    expect(groupFor("profile")).toBe("Account");
    expect(groupFor("preferences")).toBe("Account");
    expect(groupFor("security")).toBe("Account");
    expect(groupFor("feedback")).toBe("Account");
    expect(groupFor("account")).toBe("Account");
  });

  it("keeps Team, Vendors, Workspaces, and Communication on Workspace", () => {
    expect(groupFor("workspaces")).toBe("Workspace");
    expect(groupFor("team")).toBe("Workspace");
    expect(groupFor("vendors")).toBe("Workspace");
    expect(groupFor("messaging")).toBe("Workspace");
  });

  it("moves Billing and API onto Account — they belong to the login", () => {
    expect(groupFor("billing")).toBe("Account");
    expect(groupFor("developer")).toBe("Account");
  });

  it("names Team after the active workspace", () => {
    expect(src).toContain("Team · ${workspaceName}");
  });
});
