import { describe, expect, it } from "vitest";
import {
  hasIncomingAcceptedTeamLink,
  hasWorkspaceAddProperties,
  normalizeWorkspacePermissions,
} from "@/lib/workspace-co-manager-permissions";

describe("workspace co-manager permissions", () => {
  it("treats empty as no workspace access", () => {
    expect(normalizeWorkspacePermissions({})).toEqual({});
    expect(hasWorkspaceAddProperties({})).toBe(false);
  });

  it("reads addProperties only when explicitly true", () => {
    expect(hasWorkspaceAddProperties({ addProperties: true, teams: true })).toBe(true);
    expect(hasWorkspaceAddProperties({ addProperties: false })).toBe(false);
  });

  it("detects an incoming accepted team link", () => {
    expect(
      hasIncomingAcceptedTeamLink([
        { direction: "outgoing", status: "accepted" },
        { direction: "incoming", status: "pending" },
      ]),
    ).toBe(false);
    expect(hasIncomingAcceptedTeamLink([{ direction: "incoming", status: "accepted" }])).toBe(true);
  });
});
