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

describe("ManagerPropertyRoomMoveInPanel", () => {
  it("opens a room move-in editor when a room row is clicked", () => {
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

    // The list now carries the whole-house section (AXI-163), so the room
    // editor is identified by its own save action rather than by "is there a
    // move-in textarea on screen at all".
    expect(screen.getByText(/The whole house/i)).toBeTruthy();
    expect(screen.queryByTestId?.("room-move-in-save") ?? null).toBeNull();
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(1);
    expect(screen.queryByText(/Earliest move-in date/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Room B/i }));

    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    expect(screen.getAllByPlaceholderText(/Keys, parking/i)).toHaveLength(1);
    expect(screen.queryByText(/The whole house/i)).toBeNull();
    expect(screen.queryByText(/Earliest move-in date/i)).toBeNull();
  });

  it("returns to the room list from the room editor back control", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...sub.rooms[0]!,
        id: "room-a",
        name: "Room A",
        floor: "2nd floor",
        moveInInstructions: "",
      },
    ];

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

    fireEvent.click(screen.getByRole("button", { name: /Room A/i }));
    expect(screen.getByPlaceholderText(/Keys, parking/i)).toBeTruthy();
    expect(screen.queryByText(/The whole house/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rooms/i }));

    expect(screen.getByRole("button", { name: /Room A/i })).toBeTruthy();
    // Back on the list: the house section, not the room editor.
    expect(screen.getByText(/The whole house/i)).toBeTruthy();
  });
});
