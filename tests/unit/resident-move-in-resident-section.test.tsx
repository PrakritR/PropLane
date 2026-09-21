// @vitest-environment jsdom
/**
 * A manager can share a link into a specific room (`?room=<listingRoomId>`) so
 * a resident lands straight on it. That link should only ever act on the
 * VIEWER'S OWN room — matching it skips the "whole house" section (the visitor
 * came to see the room, not the house), while a link to any other room is
 * ignored outright, never redirecting or exposing someone else's section.
 *
 * The per-resident "Your spot" section renders from `resolved.residentSection`
 * alone (already scoped to the viewer's own slot by the resolver), never the
 * manager's full per-slot array.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";
import { emptyHouseInfo } from "@/lib/house-info";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/resident/move-in/info",
}));

afterEach(() => cleanup());

const baseResolved: ResidentMoveInResolved = {
  propertyLabel: "Brooklyn House",
  addressLine: "412 Vanderbilt Ave, Brooklyn NY",
  roomId: "room-1",
  roomLabel: "Room 1",
  earliestMoveInDateLabel: null,
  instructions: "Your key is the brass one.",
  moveInPhotoDataUrls: [],
  moveInVideoDataUrl: null,
  houseInstructions: "Front door code 4821. Bins go out Tuesday.",
  houseMoveInPhotoDataUrls: [],
  houseMoveInVideoDataUrl: null,
  houseInfo: emptyHouseInfo(),
  generalHouseInfo: null,
  houseRulesText: null,
  amenities: [],
  wifiNetworkName: null,
  wifiPassword: null,
  housemates: [],
  residentSection: {
    slot: 1,
    instructions: "Your bed is by the window.",
    photoDataUrls: [],
    videoDataUrl: null,
  },
};

describe("resident move-in resident section + focusRoomId", () => {
  it("renders the resident's own spot section under Resident <slot>", () => {
    render(<ResidentMoveInShell email="resident@example.com" resolved={baseResolved} activeTab="info" />);

    expect(screen.getByText("Your spot · Resident 1")).toBeTruthy();
    expect(screen.getByText("Your bed is by the window.")).toBeTruthy();
  });

  it("hides the resident section entirely when there is none", () => {
    const resolved = { ...baseResolved, residentSection: null };
    render(<ResidentMoveInShell email="resident@example.com" resolved={resolved} activeTab="info" />);

    expect(screen.queryByText(/Your spot/)).toBeNull();
  });

  it("a focusRoomId matching the viewer's own room skips the house section", () => {
    render(
      <ResidentMoveInShell
        email="resident@example.com"
        resolved={baseResolved}
        activeTab="info"
        focusRoomId="room-1"
      />,
    );

    expect(screen.queryByText("The whole house")).toBeNull();
    expect(document.body.textContent).not.toContain("Front door code 4821");
    // The room and resident sections still render.
    expect(screen.getByText("Your key is the brass one.")).toBeTruthy();
    expect(screen.getByText("Your spot · Resident 1")).toBeTruthy();
  });

  it("a focusRoomId for a DIFFERENT room is ignored — the page renders unchanged", () => {
    render(
      <ResidentMoveInShell
        email="resident@example.com"
        resolved={baseResolved}
        activeTab="info"
        focusRoomId="some-other-room"
      />,
    );

    expect(screen.getByText("The whole house")).toBeTruthy();
    expect(document.body.textContent).toContain("Front door code 4821");
  });
});
