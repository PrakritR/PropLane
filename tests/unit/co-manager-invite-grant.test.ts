import { describe, expect, it } from "vitest";
import { finalizeInviteGrant, parseInviteAccess, restampInviteHouses } from "@/lib/co-manager-invite-grant";
import { OWNER_NEEDS_HOUSE_ERROR, OWNER_SELECTED_ONLY_ERROR } from "@/lib/workspaces/membership";
import { UNKNOWN_TEAM_ROLE_ERROR } from "@/lib/co-manager-team-roles";

/**
 * The invite grant is validated once, for `/api/pro/account-links` AND PropLane Service's team verbs. These pin the
 * rules both lean on.
 */
describe("parseInviteAccess", () => {
  it("stamps a named role over the asked houses and ignores the map the body carried", () => {
    const parsed = parseInviteAccess({
      teamRole: "viewer",
      houseScope: "selected",
      assignedPropertyIds: ["h1"],
      propertyCoManagerPermissions: { h1: { payments: true, financials: true } },
    });
    expect(parsed.ok && parsed.access.teamRole).toBe("viewer");
    expect(parsed.ok && JSON.stringify(parsed.access.propertyCoManagerPermissions)).not.toMatch(/"edit":true|"delete":true|"payments":true/);
  });

  it("Custom keeps the asked map; no role at all reads as Custom (a forged role with an empty map grants nothing)", () => {
    const custom = parseInviteAccess({ teamRole: "custom", assignedPropertyIds: ["h1"], propertyCoManagerPermissions: { h1: { payments: { read: true } } } });
    expect(custom.ok && custom.access.propertyCoManagerPermissions).toEqual({ h1: { payments: { read: true } } });
    const bare = parseInviteAccess({ assignedPropertyIds: ["h1"] });
    expect(bare.ok && bare.access.teamRole).toBe("custom");
  });

  it("an unknown role is refused with the shared message", () => {
    expect(parseInviteAccess({ teamRole: "god" })).toEqual({ ok: false, error: UNKNOWN_TEAM_ROLE_ERROR });
  });

  it("an owner is never 'all houses' and needs a house someone chose", () => {
    expect(parseInviteAccess({ teamRole: "property_owner", houseScope: "all", assignedPropertyIds: ["h1"] })).toEqual({ ok: false, error: OWNER_SELECTED_ONLY_ERROR });
    expect(parseInviteAccess({ teamRole: "property_owner", assignedPropertyIds: [] })).toEqual({ ok: false, error: OWNER_NEEDS_HOUSE_ERROR });
    const ok = parseInviteAccess({ teamRole: "property_owner", assignedPropertyIds: ["h1"] });
    expect(ok.ok && ok.access.houseScope).toBe("selected");
  });
});

describe("restampInviteHouses / finalizeInviteGrant", () => {
  it("restamps a named role over the FINAL houses (all houses resolved by the caller)", () => {
    const map = restampInviteHouses({}, "leasing", ["h1", "h2"], {});
    expect(Object.keys(map)).toEqual(["h1", "h2"]);
  });

  it("an Admin invited into a workspace with no house yet stays an Admin (nothing to compare the role to)", () => {
    const final = finalizeInviteGrant({}, { teamRole: "admin", propertyCoManagerPermissions: {}, workspaceHasHouses: false });
    expect(final.teamRole).toBe("admin");
    expect(final.workspacePermissions).toEqual({});
  });

  it("an empty map on a workspace that HAS houses still reads as Custom (a forged role grants nothing)", () => {
    expect(finalizeInviteGrant({}, { teamRole: "admin", propertyCoManagerPermissions: {}, workspaceHasHouses: true }).teamRole).toBe("custom");
    // Unstated: the caller did not count, so the check stays strict.
    expect(finalizeInviteGrant({}, { teamRole: "admin", propertyCoManagerPermissions: {} }).teamRole).toBe("custom");
  });

  it("a map that no longer matches its named role reads as the role it is", () => {
    const final = finalizeInviteGrant({}, { teamRole: "admin", propertyCoManagerPermissions: { h1: { properties: { read: true } } } });
    expect(final.teamRole).toBe("custom");
  });

  it("workspace rights follow the role: only Custom carries explicit flags", () => {
    const custom = finalizeInviteGrant(
      { workspacePermissions: { teams: true } },
      { teamRole: "custom", propertyCoManagerPermissions: { h1: { payments: { read: true } } } },
    );
    expect(custom.workspacePermissions).toEqual({ teams: true });
    const viewer = finalizeInviteGrant(
      { workspacePermissions: { teams: true } },
      { teamRole: "viewer", propertyCoManagerPermissions: restampInviteHouses({}, "viewer", ["h1"], {}) },
    );
    expect(viewer.workspacePermissions).toEqual({});
  });

  it("an owner keeps owner keys only, and its flat grant is the keys the manager set", () => {
    const final = finalizeInviteGrant(
      {},
      { teamRole: "property_owner", propertyCoManagerPermissions: { h1: { payments: true, ownerStatements: { read: true } } } },
    );
    expect(JSON.stringify(final.propertyCoManagerPermissions)).not.toContain("payments");
    expect(final.coManagerPermissions).toMatchObject({ ownerStatements: { read: true } });
  });
});
