/**
 * PLAN-0917-1314 — pickers read workspace houses even when the local pipeline
 * is empty, and owned-workspace ids never include a co-managed workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeWorkspacePropertyOptions,
  ownedWorkspacePropertyIds,
  setWorkspaceSelection,
} from "@/lib/workspaces/selection";
import {
  buildManagerPropertyFilterOptions,
  ownedPropertyIdsForUser,
} from "@/lib/manager-portfolio-access";
import * as propertyPipeline from "@/lib/demo-property-pipeline";
import * as proRelationships from "@/lib/pro-relationships";
import * as portalDataStore from "@/lib/portal-data-store";
import * as applications from "@/lib/manager-applications-storage";

const threeHomes = {
  activeWorkspaceId: "w-mine",
  workspaces: [
    {
      id: "w-mine",
      name: "My workspace",
      ownerUserId: "u",
      owned: true,
      isDefault: true,
      propertyIds: ["p1", "p2", "p3"],
      propertyLabels: {
        p1: "1220 Republican St",
        p2: "5257 Brooklyn",
        p3: "4709A 8th Ave NE",
      },
      propertyPermissions: {},
    },
    {
      id: "w-shared",
      name: "Owner workspace",
      ownerUserId: "owner",
      owned: false,
      isDefault: false,
      propertyIds: ["p-co"],
      propertyLabels: { "p-co": "Co-managed house" },
      propertyPermissions: {},
    },
  ],
};

const emptyWorkspace = {
  activeWorkspaceId: "w-empty",
  workspaces: [
    {
      id: "w-empty",
      name: "33",
      ownerUserId: "u",
      owned: true,
      isDefault: false,
      propertyIds: [],
      propertyLabels: {},
      propertyPermissions: {},
    },
    {
      id: "w-default",
      name: "My workspace",
      ownerUserId: "u",
      owned: true,
      isDefault: true,
      propertyIds: ["p1", "p2"],
      propertyLabels: { p1: "House one", p2: "House two" },
      propertyPermissions: {},
    },
  ],
};

afterEach(() => {
  setWorkspaceSelection(null);
  vi.restoreAllMocks();
});

function emptyPipeline() {
  vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readScopedExtraListings").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readAllExtraListings").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readAllPendingManagerProperties").mockReturnValue([]);
  vi.spyOn(proRelationships, "readProRelationships").mockReturnValue([]);
  vi.spyOn(portalDataStore, "readCachedAccountLinkInvites").mockReturnValue([]);
  vi.spyOn(applications, "readManagerApplicationRows").mockReturnValue([]);
}

describe("active workspace property options", () => {
  it("returns the three named houses when the pipeline is empty", () => {
    setWorkspaceSelection(threeHomes);
    expect(activeWorkspacePropertyOptions()).toEqual([
      { id: "p1", label: "1220 Republican St" },
      { id: "p2", label: "5257 Brooklyn" },
      { id: "p3", label: "4709A 8th Ave NE" },
    ]);
  });

  it("is empty in a workspace that holds no houses", () => {
    setWorkspaceSelection(emptyWorkspace);
    expect(activeWorkspacePropertyOptions()).toEqual([]);
  });
});

describe("owned workspace property ids", () => {
  it("skips a co-managed workspace", () => {
    setWorkspaceSelection(threeHomes);
    expect(ownedWorkspacePropertyIds()).toEqual(["p1", "p2", "p3"]);
  });
});

describe("buildManagerPropertyFilterOptions from workspace", () => {
  beforeEach(() => emptyPipeline());

  it("lists the three workspace houses when the pipeline is empty", () => {
    setWorkspaceSelection(threeHomes);
    expect(buildManagerPropertyFilterOptions("u").map((row) => row.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("lists nothing in an empty workspace even when another workspace holds homes", () => {
    setWorkspaceSelection(emptyWorkspace);
    expect(buildManagerPropertyFilterOptions("u")).toEqual([]);
  });

  it("still lists a pipeline draft that the workspace already named", () => {
    setWorkspaceSelection(threeHomes);
    vi.spyOn(propertyPipeline, "readScopedExtraListings").mockReturnValue([
      {
        id: "p1",
        title: "Draft 1220",
        buildingName: "Draft 1220",
        tagline: "",
        address: "",
        zip: "",
        neighborhood: "",
        beds: 0,
        baths: 0,
        rentLabel: "",
        available: "",
        petFriendly: false,
        buildingId: "p1",
        unitLabel: "",
      },
    ]);
    const options = buildManagerPropertyFilterOptions("u");
    expect(options).toHaveLength(3);
    expect(options.find((row) => row.id === "p1")?.label).toContain("Draft 1220");
  });
});

describe("ownedPropertyIdsForUser", () => {
  beforeEach(() => emptyPipeline());

  it("unions owned-workspace ids when the pipeline is empty", () => {
    setWorkspaceSelection(threeHomes);
    expect([...ownedPropertyIdsForUser("u")].sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("does not treat a co-managed house as owned", () => {
    setWorkspaceSelection(threeHomes);
    expect(ownedPropertyIdsForUser("u").has("p-co")).toBe(false);
  });
});
