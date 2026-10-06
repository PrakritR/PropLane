// @vitest-environment jsdom
/**
 * C1-R5 — My home is one page of sections: Your placement, Move-in details, Roommates and
 * Inspections. These render the real shell with real data shapes. The Roommates assertions are the
 * redaction contract (docs/agents/resident-my-home.md): a field the housemate did not opt into is
 * absent from the browser props, and a missing preference discloses nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";
import { emptyHouseInfo } from "@/lib/house-info";
import { RESIDENT_MOVE_IN_TABS, RESIDENT_MOVE_IN_TAB_LABELS } from "@/lib/portal-detail-routes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/move-in/info",
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u_mia", email: "mia@example.com", ready: true }),
}));
vi.mock("@/lib/household-charges", () => ({
  readHouseholdCharges: () => [],
  isPendingUpfrontMoveInCharge: () => false,
  isUnpaidHouseholdCharge: () => false,
  syncHouseholdChargesFromServer: vi.fn().mockResolvedValue({ charges: [], rentProfiles: [] }),
}));
vi.mock("@/lib/inspections/client", () => ({ loadInspectionList: vi.fn().mockResolvedValue({ reports: [], residencies: [] }) }));
vi.mock("@/components/portal/resident-housemate-sharing", () => ({ ResidentHousemateSharing: () => <div data-testid="sharing" /> }));

const inspectionsPanel = vi.fn((_props: Record<string, unknown>) => <div data-testid="inspections-panel" />);
vi.mock("@/components/portal/inspections-panel", () => ({
  InspectionsPanel: (props: Record<string, unknown>) => inspectionsPanel(props),
  pickPrimaryInspectionReport: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const resolved: ResidentMoveInResolved = {
  propertyLabel: "Brooklyn House",
  addressLine: "412 Vanderbilt Ave, Brooklyn NY",
  roomId: "room-1",
  roomLabel: "Room 1",
  earliestMoveInDateLabel: "Oct 1, 2026",
  instructions: "Key is in the lockbox.",
  moveInPhotoDataUrls: [],
  moveInVideoDataUrl: null,
  houseInstructions: null,
  houseMoveInPhotoDataUrls: [],
  houseMoveInVideoDataUrl: null,
  houseInfo: emptyHouseInfo(),
  generalHouseInfo: "Trash goes out Tuesday night.",
  houseRulesText: null,
  amenities: ["In-unit laundry", "Backyard"],
  wifiNetworkName: null,
  wifiPassword: null,
  housemates: [
    { id: "h1", name: "Jordan", roomLabel: "Room 1", phone: "", email: "", isRoommate: true },
    { id: "h2", name: "Housemate", roomLabel: "", phone: "", email: "", isRoommate: false },
  ],
  residentSection: null,
};

const shell = (activeTab: string, extra: Record<string, unknown> = {}) =>
  render(<ResidentMoveInShell email="mia@example.com" resolved={resolved} activeTab={activeTab} leaseSigned {...extra} />);

describe("My home sections", () => {
  it("is placement, Move-in details, Roommates, Inspections — never a Forms tab, Amenities or an Inspections sidebar twin", () => {
    expect(RESIDENT_MOVE_IN_TABS.map((id) => RESIDENT_MOVE_IN_TAB_LABELS[id])).toEqual([
      "Your placement",
      "Move-in details",
      "Roommates",
      "Inspections",
    ]);
    shell("placement");
    for (const label of ["Your placement", "Move-in details", "Roommates", "Inspections"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.queryByRole("link", { name: /Amenities/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Forms/ })).toBeNull();
  });

  it("Move-in details carries the house info, the room instructions and the amenities", () => {
    shell("info");
    expect(screen.getByText("Trash goes out Tuesday night.")).toBeTruthy();
    expect(screen.getByText("Key is in the lockbox.")).toBeTruthy();
    expect(screen.getByText("Amenities")).toBeTruthy();
    expect(screen.getByText("In-unit laundry")).toBeTruthy();
  });

  it("Move-in details shows no empty Amenities block for a home that lists none", () => {
    cleanup();
    render(<ResidentMoveInShell email="mia@example.com" resolved={{ ...resolved, amenities: [] }} activeTab="info" leaseSigned />);
    expect(screen.queryByText("Amenities")).toBeNull();
  });

  it("Roommates keeps the redaction: undisclosed contact fields stay absent", () => {
    const { container } = shell("housemates");
    expect(screen.getByText("Roommates — your room")).toBeTruthy();
    expect(screen.getAllByText("Contact details not shared").length).toBe(2);
    expect(container.textContent).not.toMatch(/@/);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.getByTestId("sharing")).toBeTruthy();
  });

  it("Inspections renders the resident's list inside My home, leading with the My home tab row", () => {
    shell("inspections", { inspectionsTypeFilter: "move-out" });
    expect(screen.getByTestId("inspections-panel")).toBeTruthy();
    const props = inspectionsPanel.mock.calls[0]![0] as {
      role: string;
      routeBase: string;
      residentTypeFilter: string;
      hubTabs: { activeId: string; ariaLabel: string; destinations: { id: string; href: string }[] };
    };
    expect(props.role).toBe("resident");
    expect(props.routeBase).toBe("/resident/move-in/inspections");
    expect(props.residentTypeFilter).toBe("move-out");
    expect(props.hubTabs.activeId).toBe("inspections");
    expect(props.hubTabs.ariaLabel).toBe("My home");
    expect(props.hubTabs.destinations.map((d) => d.id)).toEqual([...RESIDENT_MOVE_IN_TABS]);
    expect(props.hubTabs.destinations.at(-1)!.href).toBe("/resident/move-in/inspections");
  });

  it("Inspections needs no resolved placement (it loads its own residencies)", () => {
    render(<ResidentMoveInShell email="mia@example.com" resolved={null} activeTab="inspections" leaseSigned />);
    expect(screen.getByTestId("inspections-panel")).toBeTruthy();
  });

  it("a form that blocks Move-in details turns that tab into a lock that links to the form, and shows no house detail", () => {
    const { container } = shell("info", { formsLock: { formId: "0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90" } });
    expect(screen.getByText("Finish your forms first")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open form" });
    expect(open.getAttribute("href")).toBe("/resident/forms/0b2f6a54-9c1d-4e3a-8d2e-7a1f5b6c8d90");
    expect(screen.queryByText("Key is in the lockbox.")).toBeNull();
    expect(screen.queryByText("Trash goes out Tuesday night.")).toBeNull();
    expect(container.querySelector('[data-attr="resident-forms-lock"]')).not.toBeNull();
  });

  it("the lock is only on Move-in details: placement and Roommates still open, and a lock with no known form goes to the list", () => {
    shell("placement", { formsLock: { formId: null } });
    expect(screen.queryByText("Finish your forms first")).toBeNull();
    cleanup();
    shell("info", { formsLock: { formId: null } });
    expect(screen.getByRole("link", { name: "Open form" }).getAttribute("href")).toBe("/resident/forms");
  });

  it("the server blanks every move-in detail (door code, Wi-Fi, rules, photos) before a locked page is built", async () => {
    const { redactMoveInDetails } = await import("@/lib/resident-move-in-resolve");
    const loaded: ResidentMoveInResolved = { ...resolved, wifiPassword: "hunter2", houseRulesText: "No parties", moveInPhotoDataUrls: ["data:a"] };
    const redacted = redactMoveInDetails(loaded);
    expect(JSON.stringify(redacted)).not.toMatch(/hunter2|No parties|data:a|Key is in the lockbox|Trash goes out|Backyard/);
    expect(redacted.propertyLabel).toBe("Brooklyn House");
    expect(redacted.roomLabel).toBe("Room 1");
    expect(redacted.housemates).toEqual(resolved.housemates);
  });
});
