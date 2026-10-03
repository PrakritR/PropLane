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

// Shape since the studio redesign (C2-TAB2, C2-TABS2-2, ui-page-structure.md § Lists): Whole house /
// Rooms tabs; every row has ONE ⋯ (Edit first); Edit opens the standard popup. There is no inline
// <details> card and no per-resident tick: a capacity-2+ room lists one "Room · Resident N" row each.
const goToRooms = () => fireEvent.click(screen.getByRole("button", { name: /^Rooms/ }));
async function rowMenuItem(row: string, name: string) {
  fireEvent.keyDown(screen.getAllByRole("button", { name: `Actions for ${row}` })[0]!, { key: "ArrowDown" });
  return screen.findByRole("menuitem", { name });
}
async function openRowEditor(row: string) {
  fireEvent.click(await rowMenuItem(row, "Edit"));
}

describe("ManagerPropertyRoomMoveInPanel", () => {
  describe("room Copy/Share row actions", () => {
    it("offers Edit first, then Copy and Share, in every room row's one ⋯ menu", async () => {
      for (const room of ["Room A", "Room B"]) {
        const { unmount } = renderPanel();
        goToRooms();
        fireEvent.keyDown(screen.getAllByRole("button", { name: `Actions for ${room}` })[0]!, { key: "ArrowDown" });
        const names = (await screen.findAllByRole("menuitem")).map((el) => el.textContent?.trim());
        expect(names[0]).toBe("Edit");
        expect(names).toContain("Copy move-in info");
        expect(names).toContain("Share move-in link");
        unmount();
        cleanup();
      }
    });

    it("disables Copy until the room has SAVED details", async () => {
      renderPanel();
      goToRooms();
      expect(await rowMenuItem("Room A", "Copy move-in info")).toBeDisabled();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(await rowMenuItem("Room B", "Copy move-in info")).not.toBeDisabled();
    });

    it("Copy writes the saved room text, including a resident with content, and never a data URL", async () => {
      renderPanel(roomListingWithResidentDetails());
      goToRooms();
      fireEvent.click(await rowMenuItem("Room B", "Copy move-in info"));
      await Promise.resolve();
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
      const text = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(text).toContain("Lockbox on porch");
      expect(text).toContain("Resident 1");
      expect(text).toContain("Your bed is by the window");
      expect(text).not.toContain("Resident 2");
      expect(text).not.toContain("data:");
    });

    it("Share writes a URL ending in /resident/move-in/info?room=<id>", async () => {
      renderPanel();
      goToRooms();
      fireEvent.click(await rowMenuItem("Room B", "Share move-in link"));
      await Promise.resolve();
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
      const url = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toContain("/resident/move-in/info?room=room-b");
    });
  });

  describe("per-resident instructions", () => {
    it("lists resident rows only for a capacity-2+ room", () => {
      renderPanel(roomListingWithResidentDetails());
      goToRooms();
      expect(screen.getByText("Room B · Resident 1")).toBeTruthy();
      expect(screen.getByText("Room B · Resident 2")).toBeTruthy();
      expect(screen.queryByText("Room A · Resident 1")).toBeNull();
    });

    it("editing a resident row and saving writes moveInResidentDetails", async () => {
      const sub = roomListingWithResidentDetails();
      // Start room-b without any resident details yet, so saving seeds a fresh entry.
      sub.rooms[1]!.moveInResidentDetails = undefined;
      renderPanel(sub);
      goToRooms();
      await openRowEditor("Room B · Resident 1");
      fireEvent.change(screen.getByPlaceholderText(/Keys, parking/i), { target: { value: "Bed near the door" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(updateExtraListingFromSubmission).toHaveBeenCalledTimes(1);
      const nextSub = updateExtraListingFromSubmission.mock.calls[0]![2] as ReturnType<typeof roomListing>;
      const savedRoomB = nextSub.rooms.find((r) => r.id === "room-b")!;
      expect(savedRoomB.moveInResidentDetails![0]!.moveInInstructions).toBe("Bed near the door");
      expect(savedRoomB.moveInInstructions).toBe("Lockbox on porch");
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

  it("opens a room's editor from its row without hiding the house details", async () => {
    renderPanel();
    // The list itself carries no inline fields; the house row is on the default tab.
    expect(screen.getByText("The whole house")).toBeTruthy();
    expect(screen.queryByDisplayValue("Lockbox on porch")).toBeNull();
    goToRooms();
    await openRowEditor("Room B");
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
  });

  it("closes a room's editor back to the section list", async () => {
    renderPanel();
    goToRooms();
    await openRowEditor("Room B");
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByDisplayValue("Lockbox on porch")).toBeNull();
    expect(screen.getByText("Room B")).toBeTruthy();
  });

  it("saves the edited room from its editor", async () => {
    renderPanel();
    goToRooms();
    await openRowEditor("Room B");
    fireEvent.change(screen.getByDisplayValue("Lockbox on porch"), { target: { value: "Use side gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(vi.mocked(updateExtraListingFromSubmission)).toHaveBeenCalledWith(
      "mgr-test",
      "mgr-1",
      expect.objectContaining({
        rooms: expect.arrayContaining([expect.objectContaining({ id: "room-b", moveInInstructions: "Use side gate" })]),
      }),
    );
  });

  it("opens the house editor from the house row without inline fields on the list", async () => {
    renderPanel();
    expect(screen.queryAllByPlaceholderText(/Keys, parking/i)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Share house details" })).toBeTruthy();
    await openRowEditor("The whole house");
    expect(screen.getAllByPlaceholderText(/Keys, parking/i).length).toBeGreaterThan(0);
  });

  /**
   * A whole-home listing has no room rows, but the house itself is still a
   * selectable row — Edit and Share live in the bulk bar, so without the tick box
   * those actions were unreachable on an entire-home property.
   */
  it("offers whole-house actions on an entire-home listing", async () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";

    render(
      <ManagerPropertyRoomMoveInPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Share house details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy house details to rooms" })).toBeNull();
    await openRowEditor("The whole house");
    expect(screen.getByPlaceholderText(/Keys, parking/i)).toBeTruthy();
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
