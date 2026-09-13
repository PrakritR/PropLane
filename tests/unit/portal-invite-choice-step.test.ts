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

  it("defaults manager invites to the PropLane ID path in the add dialog", () => {
    expect(PANEL).toContain("PortalInviteChoiceStep");
    expect(PANEL).toContain('secondaryTitle="Link with PropLane ID"');
    expect(PANEL).toContain('data-attr="co-manager-proplane-id-input"');
    expect(PANEL).toContain('data-attr="co-manager-link-continue"');
    expect(PANEL).not.toContain('data-attr="co-manager-copy-open-invite"');
    expect(PANEL).not.toContain('data-attr="co-manager-use-proplane-id"');
    expect(PANEL).not.toContain('useState<"link" | "axis">("link")');
  });

  it("keeps vendor email and shareable links available without a continuation step", () => {
    expect(VENDOR).toContain("ManagerInviteLinkModal");
    expect(VENDOR).toContain('kind="vendor"');
    expect(VENDOR).toContain('data-attr="vendor-create-invite-link"');
    expect(VENDOR).toContain("Invitation message");
    expect(VENDOR).not.toContain('data-attr="vendor-form-continue"');
    expect(VENDOR).not.toContain('data-attr="vendor-form-back"');
    expect(VENDOR).toContain('"vendor-form-send-invite"');
    expect(VENDOR).toContain('"vendor-form-add-only"');
  });

  it("draws no invite-link card when the surface passes no link handler", () => {
    expect(CHOICE).toContain("if (!onCreateInviteLink)");
  });

  // Co-manager and vendor share one modal; `kind` picks properties vs directory.
  it("mints co-manager or vendor links from the same modal", () => {
    expect(MODAL).toContain('kind?: "manager" | "vendor"');
    expect(MODAL).toContain("isVendor");
    // Vendor links carry the chosen properties too (they become the directory
    // row's assigned houses); only the module permissions stay manager-only.
    expect(MODAL).toContain("assignedPropertyIds: selectedPropIds");
    expect(MODAL).toContain("propertyPermissions: isVendor ? {} : permissions");
  });
});
