import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeWorkspacePropertyOptions,
  setWorkspaceSelection,
} from "@/lib/workspaces/selection";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import * as propertyPipeline from "@/lib/demo-property-pipeline";
import * as demoSession from "@/lib/demo/demo-session";
import * as proRelationships from "@/lib/pro-relationships";
import * as portalDataStore from "@/lib/portal-data-store";
import * as applications from "@/lib/manager-applications-storage";
import type { ManagerPendingPropertyRow } from "@/lib/demo-property-pipeline";

const USER = "mgr-options";

function emptyPipeline() {
  vi.spyOn(propertyPipeline, "readScopedExtraListings").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readExtraListingsForUser").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readAllExtraListings").mockReturnValue([]);
  vi.spyOn(propertyPipeline, "readAllPendingManagerProperties").mockReturnValue([]);
  vi.spyOn(proRelationships, "readProRelationships").mockReturnValue([]);
  vi.spyOn(portalDataStore, "readCachedAccountLinkInvites").mockReturnValue([]);
  vi.spyOn(applications, "readManagerApplicationRows").mockReturnValue([]);
  vi.spyOn(demoSession, "resolveManagerScopeUserId").mockImplementation((id) => id);
}

function workspacePayload(propertyIds: string[], propertyLabels?: Record<string, string>) {
  return {
    activeWorkspaceId: "w1",
    workspaces: [
      {
        id: "w1",
        name: "My workspace",
        ownerUserId: USER,
        owned: true,
        isDefault: true,
        propertyIds,
        propertyLabels,
        propertyPermissions: {},
      },
    ],
  };
}

const draftRow: ManagerPendingPropertyRow = {
  id: "draft-1",
  submittedAt: "2026-09-01T00:00:00.000Z",
  buildingName: "Draft House",
  address: "1 Main St",
  zip: "98105",
  neighborhood: "",
  unitLabel: "",
  beds: 1,
  baths: 1,
  monthlyRent: 1000,
  petFriendly: false,
  tagline: "",
};

beforeEach(() => {
  emptyPipeline();
});

afterEach(() => {
  setWorkspaceSelection(null);
  vi.restoreAllMocks();
});

describe("workspace property options", () => {
  it("pipeline empty + workspace 3 ids → options length 3", () => {
    setWorkspaceSelection(
      workspacePayload(["a", "b", "c"], { a: "Alpha", b: "Bravo", c: "Charlie" }),
    );
    expect(activeWorkspacePropertyOptions()).toHaveLength(3);
    expect(buildManagerPropertyFilterOptions(USER)).toHaveLength(3);
  });

  it("workspace 0 → options 0", () => {
    setWorkspaceSelection(workspacePayload([]));
    expect(activeWorkspacePropertyOptions()).toHaveLength(0);
    expect(buildManagerPropertyFilterOptions(USER)).toHaveLength(0);
  });

  it("drafts in pipeline still appear", () => {
    setWorkspaceSelection(workspacePayload(["a", "b"], { a: "Alpha", b: "Bravo" }));
    vi.spyOn(propertyPipeline, "readPendingManagerPropertiesForUser").mockReturnValue([draftRow]);
    vi.spyOn(propertyPipeline, "readAllPendingManagerProperties").mockReturnValue([draftRow]);
    const options = buildManagerPropertyFilterOptions(USER);
    expect(options.some((option) => option.id === "draft-1")).toBe(true);
    expect(options.length).toBeGreaterThanOrEqual(3);
  });
});
