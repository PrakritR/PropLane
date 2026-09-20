import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInviteTeamRole, serializeInvite } from "@/lib/account-link-invite-row";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("invite Role dropdown", () => {
  it("replaces All view / edit / manage pills with a Role field", () => {
    const panel = src("src/components/portal/pro-account-links-panel.tsx");
    expect(panel).toContain('label="Role"');
    // Admin is offered; the legacy Full access stamp is not.
    expect(panel).toContain("TEAM_ROLE_INVITE_OPTIONS");
    expect(panel).not.toContain('label: "All view"');
    expect(panel).not.toContain('label: "All edit"');
    expect(panel).not.toContain('label: "All manage"');
    // Editing an existing member: Role comes before the houses picker.
    const roleIdx = panel.indexOf("<CoManagerRoleSelect value={draft.teamRole}");
    const propertiesIdx = panel.indexOf('dataAttr="team-member-houses"');
    expect(roleIdx).toBeGreaterThan(-1);
    expect(propertiesIdx).toBeGreaterThan(roleIdx);

    // Sending a new invite: the sheet's access control offers the same role
    // set before its houses picker, with no separate pills.
    const sheet = src("src/components/portal/workspace-invite-sheet.tsx");
    expect(sheet).toContain("TEAM_ROLE_INVITE_OPTIONS");
    const sheetRoleIdx = sheet.indexOf('data-attr="workspace-invite-access"');
    const sheetHousesIdx = sheet.indexOf('dataAttr="workspace-invite-selected-houses"');
    expect(sheetRoleIdx).toBeGreaterThan(-1);
    expect(sheetHousesIdx).toBeGreaterThan(sheetRoleIdx);
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
