import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInviteTeamRole, serializeInvite } from "@/lib/account-link-invite-row";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("invite Role dropdown", () => {
  it("replaces All view / edit / manage pills with a Role field", () => {
    const fields = src("src/components/portal/workspace-permissions-fields.tsx");
    expect(fields).toContain('label="Role"');
    // Admin is offered; the legacy Full access stamp is not.
    expect(fields).toContain("TEAM_ROLE_INVITE_OPTIONS");
    expect(fields).not.toContain('label: "All view"');
    expect(fields).not.toContain('label: "All edit"');
    expect(fields).not.toContain('label: "All manage"');
    // WorkspacePermissionsFields renders Role before the houses picker.
    const roleIdx = fields.indexOf("<CoManagerRoleSelect value={role}");
    const housesIdx = fields.indexOf("<CheckboxMultiSelect");
    expect(roleIdx).toBeGreaterThan(-1);
    expect(housesIdx).toBeGreaterThan(roleIdx);

    // Editing an existing member: the shared fields component renders Role
    // before the houses picker, with no separate pills.
    const panel = src("src/components/portal/pro-account-links-panel.tsx");
    const panelFieldsIdx = panel.indexOf("<WorkspacePermissionsFields");
    const panelPropertiesIdx = panel.indexOf('dataAttr="team-member-houses"');
    expect(panelFieldsIdx).toBeGreaterThan(-1);
    expect(panelPropertiesIdx).toBeGreaterThan(panelFieldsIdx);

    // Sending a new invite: the sheet renders the same shared fields
    // component before its houses picker, with no separate pills.
    const sheet = src("src/components/portal/workspace-invite-sheet.tsx");
    const sheetFieldsIdx = sheet.indexOf("<WorkspacePermissionsFields");
    const sheetHousesIdx = sheet.indexOf('selectedHousesDataAttr="workspace-invite-selected-houses"');
    expect(sheetFieldsIdx).toBeGreaterThan(-1);
    expect(sheetHousesIdx).toBeGreaterThan(sheetFieldsIdx);
  });

  it("shows the stamped role on team rows and the accept screen", () => {
    expect(src("src/components/portal/pro-team-blocks.tsx")).toContain("roleLabel");
    expect(src("src/app/auth/co-manager-invite/co-manager-invite-client.tsx")).toContain("teamRoleLabel");
    expect(src("src/app/invite/[token]/invite-link-client.tsx")).toContain("invite-link-role");
  });
});

describe("serializeInvite teamRole", () => {
  it("reads a stored role and infers when the column is empty", () => {
    expect(resolveInviteTeamRole("leasing", {})).toBe("leasing");
    expect(resolveInviteTeamRole(null, { "prop-1": stampTeamRolePermissions("leasing")! })).toBe("leasing");
    const dto = serializeInvite(
      {
        id: "inv-1",
        inviter_user_id: "owner",
        invitee_user_id: "mate",
        tab_kind: "manager",
        inviter_axis_id: "A",
        invitee_axis_id: "B",
        inviter_display_name: "Owner",
        invitee_display_name: "Mate",
        assigned_property_ids: ["prop-1"],
        payout_percent_for_manager: 15,
        property_co_manager_permissions: {},
        status: "accepted",
        created_at: "2026-09-18T00:00:00.000Z",
        responded_at: "2026-09-18T00:00:00.000Z",
        team_role: "viewer",
      },
      "owner",
    );
    expect(dto.teamRole).toBe("viewer");
  });
});
