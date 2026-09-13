import { afterEach, describe, expect, it, vi } from "vitest";
import { readPortfolioSnapshot } from "@/components/portal/pro-dashboard-portfolio";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  adminPropertyRentDisplayLabel: () => "$100/mo",
  managerPropertyRowsForStage: () => [
    {
      listingId: "mine-1",
      adminRefId: "ref-mine",
      address: "4709A 8th Ave NE",
      buildingName: "Mine",
      submission: { rooms: [{ id: "r1" }] },
    },
    {
      listingId: "shared-1",
      adminRefId: "ref-shared",
      address: "Ash Flats",
      buildingName: "Shared",
      submission: { rooms: [{ id: "r1" }, { id: "r2" }] },
    },
  ],
}));

const selection = {
  activeWorkspaceId: "w-default",
  workspaces: [
    {
      id: "w-default",
      name: "My workspace",
      ownerUserId: "u1",
      owned: true,
      isDefault: true,
      propertyIds: ["mine-1", "ref-mine"],
      propertyPermissions: {},
    },
    {
      id: "w-shared",
      name: "Ash Flats",
      ownerUserId: "u2",
      owned: false,
      isDefault: false,
      propertyIds: ["shared-1", "ref-shared"],
      propertyPermissions: {},
    },
  ],
};

afterEach(() => setWorkspaceSelection(null));

describe("readPortfolioSnapshot workspace scope", () => {
  it("drops co-manager listings while My workspace is active", () => {
    setWorkspaceSelection(selection);
    const snap = readPortfolioSnapshot("u1");
    expect(snap.cards.every((c) => c.key === "mine-1")).toBe(true);
    expect(snap.cards.some((c) => c.key === "shared-1")).toBe(false);
  });
});
