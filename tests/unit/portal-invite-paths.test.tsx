import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("portal invite paths", () => {
  const PATHS = read("src/components/portal/portal-invite-paths.tsx");
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");
  const VENDOR = read("src/components/portal/pro-vendor-form-modal.tsx");

  it("is three methods: link, message, PropLane code — never an email tab", () => {
    expect(PATHS).toContain('value: "link"');
    expect(PATHS).toContain('value: "message"');
    expect(PATHS).toContain('value: "code"');
    expect(PATHS).toContain("Invite by");
    expect(PATHS).not.toContain("Invite by email");
    expect(PATHS).not.toContain('role="tablist"');
  });

  it("manager invite is the sheet — no chooser and no separate New message compose", () => {
    expect(PANEL).not.toContain("PortalInvitePaths");
    expect(PANEL).not.toContain("PortalInviteChoiceStep");
    expect(PANEL).not.toContain('title="New message"');
    expect(PANEL).not.toContain('dataAttr="co-manager-invite-properties"');
    expect(PANEL).toContain("<WorkspaceInviteSheet");

    const sheet = read("src/components/portal/workspace-invite-sheet.tsx");
    expect(sheet).not.toContain("PortalInvitePaths");
    expect(sheet).toContain("formatInviteMessageBody");
  });

  it("is the vendor invite chrome, then New message compose", () => {
    expect(VENDOR).toContain("PortalInvitePaths");
    expect(VENDOR).toContain('title="New message"');
    expect(VENDOR).toContain("formatInviteMessageBody");
    expect(VENDOR).toContain("<AddWorkspace");
    expect(VENDOR).toContain("vendor-form-continue");
    expect(VENDOR).not.toContain("Invite by email");
    expect(VENDOR).not.toContain("Invitation message");
  });
});
