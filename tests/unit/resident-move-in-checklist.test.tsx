// @vitest-environment jsdom
/**
 * C130 — the move-in checklist is the default content of "Your placement": a resident used to
 * check three separate tabs (Lease, Payments, Inspections) to know whether move-in was actually
 * done. Every fact it shows comes from that tab's own existing data source (`leaseSigned` is
 * already resolved by the caller's access check; charges and the inspection report are read the
 * same way their own pages read them), so this only asserts the checklist reflects those sources
 * correctly — never a fourth, independently-tracked "move-in status".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";
import { emptyHouseInfo } from "@/lib/house-info";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/move-in/placement",
}));

vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u_mia", email: "mia@example.com", ready: true }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});

const readHouseholdCharges = vi.fn();
const isPendingUpfrontMoveInCharge = vi.fn();
const isUnpaidHouseholdCharge = vi.fn();
vi.mock("@/lib/household-charges", () => ({
  readHouseholdCharges: (...args: unknown[]) => readHouseholdCharges(...args),
  isPendingUpfrontMoveInCharge: (...args: unknown[]) => isPendingUpfrontMoveInCharge(...args),
  isUnpaidHouseholdCharge: (...args: unknown[]) => isUnpaidHouseholdCharge(...args),
  syncHouseholdChargesFromServer: vi.fn().mockResolvedValue({ charges: [], rentProfiles: [] }),
}));

const loadInspectionList = vi.fn();
vi.mock("@/lib/inspections/client", () => ({
  loadInspectionList: (...args: unknown[]) => loadInspectionList(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseResolved: ResidentMoveInResolved = {
  propertyLabel: "Brooklyn House",
  addressLine: "412 Vanderbilt Ave, Brooklyn NY",
  roomId: "room-1",
  roomLabel: "Room 1",
  earliestMoveInDateLabel: "Oct 1, 2026",
  instructions: null,
  moveInPhotoDataUrls: [],
  moveInVideoDataUrl: null,
  houseInstructions: null,
  houseMoveInPhotoDataUrls: [],
  houseMoveInVideoDataUrl: null,
  houseInfo: emptyHouseInfo(),
  generalHouseInfo: null,
  houseRulesText: null,
  amenities: [],
  wifiNetworkName: null,
  wifiPassword: null,
  housemates: [],
  residentSection: null,
};

describe("move-in checklist (placement tab)", () => {
  it("marks lease, charges and inspection done once every source clears", async () => {
    readHouseholdCharges.mockReturnValue([{ id: "c1" }]);
    isPendingUpfrontMoveInCharge.mockReturnValue(true);
    isUnpaidHouseholdCharge.mockReturnValue(false);
    loadInspectionList.mockResolvedValue({
      reports: [{ id: "r1", kind: "move-in", application_id: "app-1", photos: { manager: 1, resident: 0, total: 1, lastAt: null } }],
      residencies: [],
    });

    render(<ResidentMoveInShell email="mia@example.com" resolved={baseResolved} activeTab="placement" leaseSigned />);

    expect(screen.getByText("Lease signed")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Done")).toHaveLength(3));
  });

  it("marks a charge unpaid and no inspection photos as not yet done", async () => {
    readHouseholdCharges.mockReturnValue([{ id: "c1" }]);
    isPendingUpfrontMoveInCharge.mockReturnValue(true);
    isUnpaidHouseholdCharge.mockReturnValue(true);
    loadInspectionList.mockResolvedValue({ reports: [], residencies: [] });

    render(<ResidentMoveInShell email="mia@example.com" resolved={baseResolved} activeTab="placement" leaseSigned={false} />);

    await waitFor(() => expect(screen.getAllByText("Not yet")).toHaveLength(3));
  });
});
