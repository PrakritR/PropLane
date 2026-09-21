/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** Room A: capacity 1, no saved move-in details. Room B: capacity 2, saved details incl. one resident. */
function roomListing() {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: "room-a",
      name: "Room A",
      floor: "2nd floor",
      moveInInstructions: "",
      occupancyCapacity: 1,
    },
    {
      ...sub.rooms[0]!,
      id: "room-b",
      name: "Room B",
      floor: "3rd floor",
      moveInInstructions: "Lockbox on porch",
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

function openRoomCard(container: HTMLElement, roomId: string) {
  const summary = container.querySelector(`[data-attr="property-move-in-room-${roomId}"] summary`);
  expect(summary, `summary for ${roomId} not found`).toBeTruthy();
  fireEvent.click(summary!);
}

describe("ManagerPropertyRoomMoveInPanel — room Copy/Share icon actions", () => {
  it("renders bare Copy and Share icon actions on every room row", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Copy Room A move-in info" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share Room A move-in info" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Room B move-in info" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share Room B move-in info" })).toBeTruthy();
  });

  it("disables Copy until the room has SAVED details", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Copy Room A move-in info" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy Room B move-in info" })).not.toBeDisabled();
  });

  it("Copy writes the saved room text, including a resident with content, and never a data URL", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy Room B move-in info" }));
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const text = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(text).toContain("Lockbox on porch");
    expect(text).toContain("Resident 1");
    expect(text).toContain("Your bed is by the window");
    expect(text).not.toContain("Resident 2");
    expect(text).not.toContain("data:");
  });

  it("Share writes a URL ending in /resident/move-in?room=<id>", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Share Room B move-in info" }));
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const url = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain("/resident/move-in?room=room-b");
  });
});

describe("ManagerPropertyRoomMoveInPanel — per-resident instructions tick", () => {
  it("shows the tick only on a capacity-2+ room", () => {
    const { container } = renderPanel();
    openRoomCard(container, "room-a");
    openRoomCard(container, "room-b");
    const roomACard = container.querySelector('[data-attr="property-move-in-room-room-a"]')!;
    const roomBCard = container.querySelector('[data-attr="property-move-in-room-room-b"]')!;
    expect(roomACard.querySelector('[data-attr="property-move-in-per-resident"]')).toBeNull();
    expect(roomBCard.querySelector('[data-attr="property-move-in-per-resident"]')).toBeTruthy();
  });

  it("ticking on shows one block per resident slot, and saving writes moveInResidentDetails", () => {
    const sub = roomListing();
    // Start room-b without any resident details yet, so ticking on seeds fresh empty entries.
    sub.rooms[1]!.moveInResidentDetails = undefined;
    const { container } = renderPanel(sub);
    openRoomCard(container, "room-b");

    const roomBCard = container.querySelector('[data-attr="property-move-in-room-room-b"]')!;
    const checkbox = roomBCard.querySelector('[data-attr="property-move-in-per-resident"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    const blocks = roomBCard.querySelectorAll('[data-attr="property-move-in-resident-block"]');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.getAttribute("data-slot")).toBe("1");
    expect(blocks[1]!.getAttribute("data-slot")).toBe("2");

    const firstTextarea = blocks[0]!.querySelector("textarea")!;
    fireEvent.change(firstTextarea, { target: { value: "Bed near the door" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateExtraListingFromSubmission).toHaveBeenCalledTimes(1);
    const nextSub = updateExtraListingFromSubmission.mock.calls[0]![2] as ReturnType<typeof roomListing>;
    const savedRoomB = nextSub.rooms.find((r) => r.id === "room-b")!;
    expect(savedRoomB.moveInResidentDetails).toHaveLength(2);
    expect(savedRoomB.moveInResidentDetails![0]!.moveInInstructions).toBe("Bed near the door");
    expect(savedRoomB.moveInResidentDetails![1]!.moveInInstructions).toBe("");
  });
});

describe("ManagerPropertyRoomMoveInPanel — copy house details to rooms", () => {
  it("leaves a room's moveInResidentDetails intact", () => {
    const sub = roomListing();
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
