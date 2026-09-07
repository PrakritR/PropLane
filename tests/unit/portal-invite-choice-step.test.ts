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

  // A redeemed link can only ever create an `account_link_invites` co-manager row,
  // so the vendor form must not offer a shareable link it has no way to honour.
  it("keeps the vendor form on the email path with no shareable-link card", () => {
    expect(VENDOR).toContain("PortalInviteChoiceStep");
    expect(VENDOR).not.toContain("onCreateInviteLink");
    expect(VENDOR).not.toContain("ManagerInviteLinkModal");
    expect(VENDOR).not.toContain('kind="vendor"');
    expect(VENDOR).toContain('secondaryTitle="Invite by email"');
    expect(VENDOR).toContain("ManagerVendorEssentialFields");
    expect(VENDOR).toContain("ManagerVendorOptionalFields");
    expect(VENDOR).toContain('data-attr="vendor-form-continue"');
    expect(VENDOR).toContain('data-attr="vendor-form-back"');
    expect(VENDOR).toContain('"vendor-form-send-invite"');
    expect(VENDOR).toContain('"vendor-form-add-only"');
    expect(VENDOR).not.toContain('data-attr="vendor-form-preview-invite"');
  });

  it("draws no invite-link card when the surface passes no link handler", () => {
    expect(CHOICE).toContain("if (!onCreateInviteLink)");
  });

  // A redeemed link only ever yields a co-manager invite, so the mint modal has no
  // vendor mode to render — the refusal is a compile-time fact, not a runtime 400.
  it("mints co-manager links only", () => {
    expect(MODAL).not.toContain("kind?: InviteLinkKind");
    expect(MODAL).not.toContain("isManagerLink");
    expect(MODAL).toContain('kind: "manager"');
  });
});
