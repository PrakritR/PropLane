/**
 * An empty workspace must read as "nothing here" while the account still holds
 * homes elsewhere — the counts and the empty state agree with the list filter.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  activeWorkspacePropertyIds,
  activeWorkspaceScope,
  propertiesOutsideActiveWorkspace,
  setWorkspaceSelection,
  workspaceContainsProperty,
} from "@/lib/workspaces/selection";

const payload = {
  activeWorkspaceId: "w-33",
  workspaces: [
    { id: "w-default", name: "My workspace", ownerUserId: "u", owned: true, isDefault: true, propertyIds: ["p1", "p2"], propertyPermissions: {} },
    { id: "w-33", name: "33", ownerUserId: "u", owned: true, isDefault: false, propertyIds: [], propertyPermissions: {} },
  ],
};

afterEach(() => setWorkspaceSelection(null));

describe("active workspace scope", () => {
  it("names the empty workspace and counts the homes it is missing", () => {
    setWorkspaceSelection(payload);
    expect(activeWorkspaceScope()).toEqual({ name: "33", isDefault: false, propertyCount: 0, narrowing: true });
    expect(propertiesOutsideActiveWorkspace()).toBe(2);
    expect(workspaceContainsProperty("p1")).toBe(false);
  });

  it("reads the whole account before a selection exists", () => {
    expect(activeWorkspaceScope()).toBeNull();
    expect(propertiesOutsideActiveWorkspace()).toBe(0);
    expect(workspaceContainsProperty("p1")).toBe(true);
  });

  it("is quiet in the default workspace that holds the homes", () => {
    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    expect(activeWorkspaceScope()).toMatchObject({ name: "My workspace", propertyCount: 2 });
    expect(propertiesOutsideActiveWorkspace()).toBe(0);
  });

  it("excludes a property that only exists in a shared workspace", () => {
    setWorkspaceSelection({
      activeWorkspaceId: "w-default",
      workspaces: [
        {
          id: "w-default",
          name: "My workspace",
          ownerUserId: "u",
          owned: true,
          isDefault: true,
          propertyIds: ["p1"],
          propertyPermissions: {},
        },
        {
          id: "w-shared",
          name: "Owner workspace",
          ownerUserId: "owner",
          owned: false,
          isDefault: false,
          propertyIds: ["p-co"],
          propertyPermissions: { "p-co": {} },
        },
      ],
    });
    expect(workspaceContainsProperty("p-co")).toBe(false);
    expect(workspaceContainsProperty("p1")).toBe(true);
  });

  /**
   * The bug this guards: a workspace holding no homes showed every tour,
   * application and resident in the account, because a property id no
   * workspace claimed fell back to the default workspace and an empty scope
   * was read as "no scope at all".
   */
  it("hides a house no workspace claims once the account is partitioned", () => {
    setWorkspaceSelection(payload);
    expect(workspaceContainsProperty("mgr-demo-cascade")).toBe(false);
    expect(activeWorkspacePropertyIds()).toEqual([]);

    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    // Not even the default workspace takes in an unplaced house once a second
    // workspace exists; membership is the only test.
    expect(workspaceContainsProperty("mgr-demo-cascade")).toBe(false);
    expect(activeWorkspacePropertyIds()).toEqual(["p1", "p2"]);
  });

  it("keeps a single-workspace account exactly as it was", () => {
    setWorkspaceSelection({
      activeWorkspaceId: "w-default",
      workspaces: [
        {
          id: "w-default",
          name: "My workspace",
          ownerUserId: "u",
          owned: true,
          isDefault: true,
          propertyIds: ["p1"],
          propertyPermissions: {},
        },
      ],
    });
    // One workspace is the whole account, so a house it has not recorded yet
    // and a row with no house at all both still show.
    expect(workspaceContainsProperty("not-synced-yet")).toBe(true);
    expect(workspaceContainsProperty(undefined)).toBe(true);
    expect(activeWorkspacePropertyIds()).toBeNull();
    expect(activeWorkspaceScope()).toMatchObject({ narrowing: false });
  });

  it("keeps an account-level row out of a second workspace", () => {
    setWorkspaceSelection(payload);
    expect(workspaceContainsProperty(undefined)).toBe(false);
    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    expect(workspaceContainsProperty(undefined)).toBe(false);
  });
});
