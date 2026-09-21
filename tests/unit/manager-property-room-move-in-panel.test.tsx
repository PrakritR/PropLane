/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { updateExtraListingFromSubmission } from "@/lib/demo-property-pipeline";

vi.mock("@/lib/demo-property-pipeline", () => ({
  updateExtraListingFromSubmission: vi.fn(() => true),
  updatePendingManagerProperty: vi.fn(() => true),
}));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  updateRequestChangeProperty: vi.fn(() => true),
}));

afterEach(() => {
  cleanup();
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

describe("ManagerPropertyRoomMoveInPanel", () => {
  it("expands a room's inline editor without hiding the house details", () => {
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByText(/The whole house/i)).toBeTruthy();
    const roomDetails = screen.getByText("Room B").closest("details")!;
    expect(roomDetails.open).toBe(false);

    roomDetails.open = true;
    fireEvent(roomDetails, new Event("toggle"));

    expect(roomDetails.open).toBe(true);
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
  });

  it("collapses a room back to the section list", () => {
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    const roomDetails = screen.getByText("Room B").closest("details")!;
    roomDetails.open = true;
    fireEvent(roomDetails, new Event("toggle"));
    expect(roomDetails.open).toBe(true);

    roomDetails.open = false;
    fireEvent(roomDetails, new Event("toggle"));
    expect(roomDetails.open).toBe(false);
  });

  it("saves the edited room from its expanded section", () => {
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Room B").closest("summary")!);
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

  it("opens the house editor from the house row without inline fields on the list", () => {
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByText("The whole house").closest("details")?.open).toBe(true);
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Share house details" })).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
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
    expect(screen.getByPlaceholderText(/Keys, parking/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share house details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy house details to rooms" })).toBeNull();
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
