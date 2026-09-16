/**
 * An empty workspace must read as "nothing here" while the account still holds
 * homes elsewhere — the counts and the empty state agree with the list filter.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  activeWorkspacePropertyIds,
  activeWorkspaceScope,
  filterPropertyOptionsForActiveWorkspace,
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

  /**
   * The second time this bug was reported it was on a single-workspace
   * account with zero properties and eight tours. Membership is the only test
   * now, at any workspace count: a house the workspace does not hold does not
   * show, and a workspace with no houses shows nothing that names one.
   */
  it("shows nothing that names a house the workspace does not hold, even with one workspace", () => {
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
    expect(workspaceContainsProperty("p1")).toBe(true);
    expect(workspaceContainsProperty("mgr-demo-cascade")).toBe(false);
    // Account-level rows with no house still live in the owned default workspace.
    expect(workspaceContainsProperty(undefined)).toBe(true);
    // The scope is the workspace's houses, so an empty workspace is an empty scope.
    expect(activeWorkspacePropertyIds()).toEqual(["p1"]);
    expect(activeWorkspaceScope()).toMatchObject({ narrowing: false });
  });

  it("gives an empty single workspace an empty scope, never no scope", () => {
    setWorkspaceSelection({
      activeWorkspaceId: "w-default",
      workspaces: [
        { id: "w-default", name: "My workspace", ownerUserId: "u", owned: true, isDefault: true, propertyIds: [], propertyPermissions: {} },
      ],
    });
    expect(activeWorkspacePropertyIds()).toEqual([]);
    expect(workspaceContainsProperty("mgr-scale-06")).toBe(false);
  });

  it("keeps an account-level row out of a second workspace", () => {
    setWorkspaceSelection(payload);
    expect(workspaceContainsProperty(undefined)).toBe(false);
    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    expect(workspaceContainsProperty(undefined)).toBe(false);
  });

  it("filters Applies-to options to the active workspace houses", () => {
    setWorkspaceSelection(payload);
    expect(
      filterPropertyOptionsForActiveWorkspace([
        { id: "p1", label: "One" },
        { id: "p2", label: "Two" },
        { id: "p-other", label: "Other" },
      ]),
    ).toEqual([]);
    setWorkspaceSelection({ ...payload, activeWorkspaceId: "w-default" });
    expect(
      filterPropertyOptionsForActiveWorkspace([
        { id: "p1", label: "One" },
        { id: "p2", label: "Two" },
        { id: "p-other", label: "Other" },
      ]),
    ).toEqual([
      { id: "p1", label: "One" },
      { id: "p2", label: "Two" },
    ]);
  });
});
