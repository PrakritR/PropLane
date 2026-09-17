import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inviteAcceptSubtitle, inviteAcceptTitle } from "@/lib/invite-links/invite-accept-copy";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("invite accept copy", () => {
  it("titles a manager invite Invite to workspace and names the workspace", () => {
    expect(inviteAcceptTitle("manager")).toBe("Invite to workspace");
    expect(inviteAcceptSubtitle({ kind: "manager", ownerName: "Ambika", workspaceName: "Seattle houses" })).toBe(
      "Ambika invited you to Seattle houses on PropLane.",
    );
  });

  it("is used on both accept URLs", () => {
    const link = read("src/app/invite/[token]/invite-link-client.tsx");
    const open = read("src/app/auth/co-manager-invite/co-manager-invite-client.tsx");
    expect(link).toContain("inviteAcceptTitle");
    expect(link).toContain("Message {firstNameFromDisplay(preview.ownerName)}");
    expect(open).toContain("Invite to workspace");
    expect(open).toContain("Message {firstNameFromDisplay(preview.inviterDisplayName)}");
  });
});
