import { describe, expect, it } from "vitest";
import { assignedIdsInWorkspace, grantBelongsToWorkspace, teamGrantVisibleInWorkspace } from "@/lib/workspaces/team-scope";

describe("teamGrantVisibleInWorkspace", () => {
  const workspace = ["house-a", "house-b"];

  it("shows an invite that has no houses yet so it can be assigned here", () => {
    expect(teamGrantVisibleInWorkspace([], workspace)).toBe(true);
    expect(teamGrantVisibleInWorkspace([], [])).toBe(true);
  });

  it("shows a member who has a house in this workspace", () => {
    expect(teamGrantVisibleInWorkspace(["house-b", "other"], workspace)).toBe(true);
  });

  it("hides a member whose houses are only in another workspace", () => {
    expect(teamGrantVisibleInWorkspace(["other"], workspace)).toBe(false);
    expect(teamGrantVisibleInWorkspace(["other"], [])).toBe(false);
  });

  it("returns only the houses that sit in this workspace", () => {
    expect(assignedIdsInWorkspace(["house-a", "other", "house-b"], workspace)).toEqual(["house-a", "house-b"]);
  });
});

const ws = (propertyIds: string[], extra: Partial<{ isDefault: boolean; owned: boolean }> = {}) => ({
  propertyIds,
  isDefault: extra.isDefault ?? false,
  owned: extra.owned ?? true,
});

describe("grantBelongsToWorkspace", () => {
  it("lists a co-manager under every workspace that holds one of their houses", () => {
    const grant = ["house-a", "house-c"];
    expect(grantBelongsToWorkspace(grant, ws(["house-a", "house-b"], { isDefault: true }))).toBe(true);
    expect(grantBelongsToWorkspace(grant, ws(["house-c"]))).toBe(true);
    expect(grantBelongsToWorkspace(grant, ws(["house-d"]))).toBe(false);
  });

  it("puts a grant with no houses yet under the default workspace only", () => {
    expect(grantBelongsToWorkspace([], ws(["house-a"], { isDefault: true }))).toBe(true);
    expect(grantBelongsToWorkspace([], ws(["house-b"]))).toBe(false);
  });

  it("follows the house when it moves between workspaces", () => {
    const grant = ["house-a"];
    expect(grantBelongsToWorkspace(grant, ws(["house-a"], { isDefault: true }))).toBe(true);
    expect(grantBelongsToWorkspace(grant, ws([], { isDefault: true }))).toBe(false);
    expect(grantBelongsToWorkspace(grant, ws(["house-a"]))).toBe(true);
  });

  it("never lists team rows under a workspace shared with you", () => {
    expect(grantBelongsToWorkspace(["house-a"], ws(["house-a"], { owned: false }))).toBe(false);
    expect(grantBelongsToWorkspace([], ws(["house-a"], { owned: false, isDefault: true }))).toBe(false);
  });

});
