import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-account-links-panel.tsx", "utf8");
const blocks = readFileSync("src/components/portal/pro-team-blocks.tsx", "utf8");
const applications = readFileSync("src/components/portal/pro-applications.tsx", "utf8");

describe("Edit permissions is a popup", () => {
  it("the member ⋯ menu calls onEdit instead of opening a member page", () => {
    expect(blocks).toContain('label: "Edit permissions"');
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
