import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("portal invite choice step", () => {
  const CHOICE = read("src/components/portal/portal-invite-choice-step.tsx");
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");
  const VENDOR = read("src/components/portal/pro-vendor-form-modal.tsx");
  const MODAL = read("src/components/portal/manager-invite-link-modal.tsx");

  it("surfaces invite-by-link as the recommended primary path", () => {
    expect(CHOICE).toContain("Recommended");
    expect(CHOICE).toContain("Create Invite Link");
  });

  it("wires manager link account through the shared chooser", () => {
    expect(PANEL).toContain("PortalInviteChoiceStep");
    expect(PANEL).toContain('inviteLinkDataAttr="link-account-invite-link"');
  });

  it("wires vendor invite through the shared chooser and vendor link modal", () => {
    expect(VENDOR).toContain("PortalInviteChoiceStep");
    expect(VENDOR).toContain('inviteLinkDataAttr="vendor-invite-link-open"');
    expect(VENDOR).toContain('kind="vendor"');
  });

  it("passes invite kind through the mint modal", () => {
    expect(MODAL).toContain("kind?: InviteLinkKind");
    expect(MODAL).toContain("kind,");
  });
});
