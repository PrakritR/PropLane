/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/manager-property-room-move-in-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

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
  it("expands a room editor inline when a room row is clicked", () => {
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
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Room B/i }));

    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(2);
    expect(screen.getByText(/The whole house/i)).toBeTruthy();
    expect(screen.getByTestId("room-move-in-save")).toBeTruthy();
  });

  it("collapses the inline room editor when the row is clicked again", () => {
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

    const roomButton = screen.getByRole("button", { name: /Room B/i });
    fireEvent.click(roomButton);
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();

    fireEvent.click(roomButton);
    expect(screen.queryByDisplayValue("Lockbox on porch")).toBeNull();
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(1);
  });

  it("hides save actions while rooms are selected and shows edit + share bulk actions", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Room B/i }));
    expect(screen.getByTestId("room-move-in-save")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Select Room B"));
    expect(screen.queryByTestId("room-move-in-save")).toBeNull();
    expect(screen.queryByTestId("house-move-in-save")).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Share$/i })).toBeTruthy();
  });
});
