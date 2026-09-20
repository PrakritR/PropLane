import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-account-links-panel.tsx", "utf8");
const blocks = readFileSync("src/components/portal/pro-team-blocks.tsx", "utf8");
const applications = readFileSync("src/components/portal/pro-applications.tsx", "utf8");

describe("Edit permissions is a popup", () => {
  it("the member ⋯ menu calls onEdit instead of opening a member page", () => {
    expect(blocks).toContain('label: "Edit"');
    expect(blocks).toContain("onSelect: m.onEdit");
    expect(blocks).toContain('dataAttr: "team-member-edit"');
    expect(blocks).toContain("opens a sheet on this page — not a");
  });

  it("the managers panel mounts Edit permissions in a modal", () => {
    expect(panel).toContain("setPermissionsMember(entry)");
    expect(panel).toContain("open={permissionsMember !== null}");
    expect(panel).toContain('dataAttr="team-member-permissions-modal"');
    expect(panel).toContain("`Edit permissions · ${permissionsMember.name}`");
  });

  it("pending invite Edit opens the member sheet, not a member page", () => {
    expect(panel).toContain("openMemberSheet(inv.id)");
    expect(panel).not.toContain("onOpen={(inv) => openTeamDetail(inv.id)}");
    expect(blocks).toContain('label: "Edit"');
    expect(blocks).toContain('dataAttr: "team-pending-edit"');
    expect(blocks).toContain('label: "Revoke"');
    expect(blocks).not.toContain('label: "Copy link"');
  });

  it("does not open a nested Untitled property permissions modal", () => {
    expect(panel).not.toContain("Edit permissions · ${propertyPermissionsModal.propertyLabel}");
    expect(panel).not.toContain("No properties in this link yet.");
    expect(panel).toContain('dataAttr="team-member-houses"');
  });

  it("moves ownership transfer to the member's ⋯ menu instead of a dead property bulk bar", () => {
    expect(panel).not.toContain('data-attr="co-manager-make-owner"');
    expect(blocks).toContain('dataAttr: "team-member-transfer"');
    expect(panel).toContain('data-attr="team-member-transfer"');
    expect(panel).not.toContain("team-detail-bulk-make-owner");
    expect(panel).not.toContain("selectedDetailPropertyIds");
  });
});

describe("Applications keep Super plan chrome and open the resident wizard", () => {
  it("keeps Add applicant and Form|Automation, without the on-behalf modal", () => {
    expect(applications).toContain('label: "Add applicant"');
    expect(applications).toContain("AddResidentWizard");
    expect(applications).toContain("setAddApplicationOpen(true)");
    expect(applications).not.toContain('from "@/components/portal/pro-application-on-behalf-modal"');
    expect(applications).not.toMatch(/<ManagerApplicationOnBehalfModal/);
  });
});
