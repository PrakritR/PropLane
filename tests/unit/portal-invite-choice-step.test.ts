import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("portal invite choice step", () => {
  const CHOICE = read("src/components/portal/portal-invite-choice-step.tsx");
  const PATHS = read("src/components/portal/portal-invite-paths.tsx");
  const PANEL = read("src/components/portal/pro-account-links-panel.tsx");
  const VENDOR = read("src/components/portal/pro-vendor-form-modal.tsx");
  const MODAL = read("src/components/portal/manager-invite-link-modal.tsx");

  it("keeps the legacy two-card chooser as an unused primitive", () => {
    expect(CHOICE).toContain("Recommended");
    expect(CHOICE).toContain("Create Invite Link");
  });

  it("defaults manager invites to three paths, with properties always on the first step", () => {
    expect(PANEL).toContain("PortalInvitePaths");
    expect(PANEL).not.toContain("PortalInviteChoiceStep");
    expect(PANEL).toContain('data-attr="co-manager-proplane-id-input"');
    expect(PANEL).toContain('data-attr="co-manager-link-continue"');
    expect(PANEL).not.toContain('data-attr="co-manager-copy-open-invite"');
    expect(PANEL).not.toContain('data-attr="co-manager-use-proplane-id"');
  });

  it("sends vendor invites through Continue into New message", () => {
    expect(VENDOR).toContain("PortalInvitePaths");
    expect(VENDOR).toContain("vendor-form-continue");
    expect(VENDOR).not.toContain("Invitation message");
    expect(VENDOR).toContain("formatInviteMessageBody");
  });

  it("draws no invite-link card when the surface passes no link handler", () => {
    expect(CHOICE).toContain("if (!onCreateInviteLink)");
  });

  it("mints co-manager or vendor links from the same modal", () => {
    expect(MODAL).toContain('kind?: "manager" | "vendor"');
    expect(MODAL).toContain("isVendor");
    expect(MODAL).toContain("assignedPropertyIds: selectedPropIds");
    expect(MODAL).toContain("propertyPermissions: isVendor ? {} : permissions");
  });

  it("uses the shared three-path chrome for workspace and vendor", () => {
    expect(PATHS).toContain('data-attr="portal-invite-paths"');
    expect(VENDOR).toContain("PortalInvitePaths");
  });
});
