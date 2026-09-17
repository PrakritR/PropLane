import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("portal invite paths", () => {
  const PATHS = read("src/components/portal/portal-invite-paths.tsx");
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");
  const VENDOR = read("src/components/portal/pro-vendor-form-modal.tsx");

  it("is three methods: link, message, PropLane code — never an email tab", () => {
    expect(PATHS).toContain('id: "link"');
    expect(PATHS).toContain('id: "message"');
    expect(PATHS).toContain('id: "code"');
    expect(PATHS).toContain("Invite via PropLane code");
    expect(PATHS).not.toContain("Invite by email");
  });

  it("is the workspace invite chrome, then New message compose", () => {
    expect(PANEL).toContain("PortalInvitePaths");
    expect(PANEL).not.toContain("PortalInviteChoiceStep");
    expect(PANEL).toContain('title="New message"');
    expect(PANEL).toContain("formatInviteMessageBody");
    expect(PANEL).toContain('dataAttr="co-manager-invite-properties"');
  });

  it("is the vendor invite chrome, then New message compose", () => {
    expect(VENDOR).toContain("PortalInvitePaths");
    expect(VENDOR).toContain('title="New message"');
    expect(VENDOR).toContain("formatInviteMessageBody");
    expect(VENDOR).toContain('data-attr="vendor-form-continue"');
    expect(VENDOR).not.toContain("Invite by email");
    expect(VENDOR).not.toContain("Invitation message");
  });
});
