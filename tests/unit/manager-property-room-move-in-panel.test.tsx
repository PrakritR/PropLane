/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const { updateExtraListingFromSubmission, updatePendingManagerProperty } = vi.hoisted(() => ({
  updateExtraListingFromSubmission: vi.fn(() => true),
  updatePendingManagerProperty: vi.fn(() => true),
}));

vi.mock("@/lib/demo-property-pipeline", () => ({
  updateExtraListingFromSubmission,
  updatePendingManagerProperty,
}));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  updateRequestChangeProperty: vi.fn(() => true),
}));

beforeEach(() => {
  updateExtraListingFromSubmission.mockClear();
  updatePendingManagerProperty.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function roomListing() {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: "room-a",
      name: "Room A",
      floor: "2nd floor",
      moveInInstructions: "",
    },
    {
      ...sub.rooms[0]!,
      id: "room-b",
      name: "Room B",
      floor: "3rd floor",
      moveInInstructions: "Lockbox on porch",
    },
  ];
  return sub;
}

/** Room A: capacity 1, no saved move-in details. Room B: capacity 2, saved details incl. one resident. */
function roomListingWithResidentDetails() {
  const sub = roomListing();
  sub.rooms = [
    { ...sub.rooms[0]!, occupancyCapacity: 1 },
    {
      ...sub.rooms[1]!,
      occupancyCapacity: 2,
      moveInResidentDetails: [
        { moveInInstructions: "Your bed is by the window", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
        { moveInInstructions: "", moveInPhotoDataUrls: [], moveInVideoDataUrl: null },
      ],
    },
  ];
  return sub;
}

function renderPanel(sub = roomListing()) {
  return render(
    <ManagerPropertyRoomMoveInPanel
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-test" }}
      managerUserId="mgr-1"
      canEdit
      onUpdated={() => {}}
      showToast={() => {}}
    />,
  );
}

describe("ManagerPropertyRoomMoveInPanel", () => {
  /**
   * studio-redesign(property-tabs): Move-in is ONE header card (tabs with counts,
   * search, icon actions, round +), then rows of tile · title · one glyph-fact
   * line · exactly one ⋯ — not an empty card of its own plus a second tabs card.
   */
  describe("one header card", () => {
    it("draws a single command bar holding the tabs, search, gear, copy, share and the round +", () => {
      const onAddResident = vi.fn();
      const { container } = render(
        <ManagerPropertyRoomMoveInPanel
          sub={roomListing()}
          saveTarget={{ mode: "listing", saveId: "mgr-test" }}
          managerUserId="mgr-1"
          canEdit
          onUpdated={() => {}}
          showToast={() => {}}
          onAddResident={onAddResident}
        />,
      );
      const stacks = container.querySelectorAll('[data-slot="portal-list-control-stack"]');
      expect(stacks).toHaveLength(1);
      const stack = stacks[0]!;
      expect(within(stack as HTMLElement).getByRole("button", { name: /Whole house/ })).toBeTruthy();
      expect(within(stack as HTMLElement).getByRole("button", { name: /Rooms/ })).toBeTruthy();
      expect(within(stack as HTMLElement).getByPlaceholderText("Search move-in")).toBeTruthy();
      for (const name of ["Move-in settings", "Copy house details to rooms", "Share house details"]) {
        expect(within(stack as HTMLElement).getByRole("button", { name })).toBeTruthy();
      }
      const add = within(stack as HTMLElement).getByRole("button", { name: "Add resident" });
      fireEvent.click(add);
      expect(onAddResident).toHaveBeenCalledTimes(1);
    });

    it("has no round + when nothing can open it", () => {
      renderPanel();
      expect(screen.queryByRole("button", { name: "Add resident" })).toBeNull();
    });
  });

  describe("rows", () => {
    it("whole-house row: square tile, glyph facts (no 'Nothing added yet' sentence), one ⋯", () => {
      const { container } = renderPanel();
      const row = container.querySelector('[data-attr="property-move-in-house-row"]')!.closest(".portal-property-row")!;
      expect(row.querySelector('[data-slot="portal-row-icon-tile"]')).toBeTruthy();
      const facts = row.querySelector('[data-attr="record-row-facts"]')!;
      expect(facts.textContent).toContain("No instructions yet");
      expect(facts.textContent).toContain("0 photos");
      expect(facts.textContent).toContain("No video");
      expect(row.textContent).not.toContain("Nothing added yet");
      expect(row.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
    });

    it("room rows on the Rooms tab: tile, facts that read the saved instructions, one ⋯ each", () => {
      const { container } = renderPanel();
      fireEvent.click(screen.getByRole("button", { name: /Rooms/ }));
      const rowA = container.querySelector('[data-attr="property-move-in-room-row-room-a"]')!.closest(".portal-property-row")!;
      const rowB = container.querySelector('[data-attr="property-move-in-room-row-room-b"]')!.closest(".portal-property-row")!;
      expect(rowA.querySelector('[data-slot="portal-row-icon-tile"]')).toBeTruthy();
      expect(rowA.textContent).toContain("No instructions yet");
      expect(rowB.textContent).toContain("Instructions written");
      expect(rowA.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
      expect(rowB.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
    });

    it("a capacity-2 room also lists one row per resident slot, each with a single ⋯", () => {
      const { container } = renderPanel(roomListingWithResidentDetails());
      fireEvent.click(screen.getByRole("button", { name: /Rooms/ }));
      const slot = container.querySelector('[data-attr="property-move-in-resident-row-room-b-0"]')!.closest(".portal-property-row")!;
      expect(slot.textContent).toContain("Room B · Resident 1");
      expect(slot.textContent).toContain("Instructions written");
      expect(slot.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1);
    });
  });

  describe("copy house details to rooms", () => {
    it("leaves a room's moveInResidentDetails intact", () => {
      const sub = roomListingWithResidentDetails();
      sub.houseMoveInInstructions = "Front door code 4821.";
      sub.houseMoveInPhotoDataUrls = ["data:image/png;base64,house"];
      sub.houseMoveInVideoDataUrl = null;

      renderPanel(sub);
      fireEvent.click(screen.getByRole("button", { name: "Copy house details to rooms" }));

      expect(updateExtraListingFromSubmission).toHaveBeenCalledTimes(1);
      const nextSub = updateExtraListingFromSubmission.mock.calls[0]![2] as ReturnType<typeof roomListing>;
      const roomB = nextSub.rooms.find((r) => r.id === "room-b")!;
      expect(roomB.moveInInstructions).toBe("Front door code 4821.");
      expect(roomB.moveInResidentDetails).toEqual(sub.rooms[1]!.moveInResidentDetails);
    });
  });

  /** A whole-home listing has no Rooms tab: the house row is the only row. */
  it("shows no tab row of its own on an entire-home listing", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    const { container } = render(
      <ManagerPropertyRoomMoveInPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );
    expect(container.querySelectorAll('[data-slot="portal-list-control-stack"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Rooms/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy house details to rooms" })).toBeNull();
    expect(container.querySelector('[data-attr="property-move-in-house-row"]')).toBeTruthy();
  });

  it("omits whole-house edit actions when the manager cannot edit", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";

    render(
      <ManagerPropertyRoomMoveInPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit={false}
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.queryByLabelText("Select the whole house")).toBeNull();
    expect(screen.getByText(/The whole house/i)).toBeTruthy();
  });
});
