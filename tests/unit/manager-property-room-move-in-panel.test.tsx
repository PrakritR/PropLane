/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
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
  it("opens a drill-in editor when a room row is clicked", () => {
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
    expect(screen.queryByPlaceholderText(/Keys, parking/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Room B/i }));

    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Keys, parking/i)).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
    expect(screen.getByRole("button", { name: /Back/i })).toBeTruthy();
  });

  it("returns to the list when back is clicked from the editor", () => {
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
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(screen.queryByDisplayValue("Lockbox on porch")).toBeNull();
    expect(screen.queryByPlaceholderText(/Keys, parking/i)).toBeNull();
  });

  it("shows edit and share bulk actions when rooms are selected", () => {
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

    fireEvent.click(screen.getByLabelText("Select Room B"));
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Share$/i })).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
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

    expect(screen.queryByPlaceholderText(/Keys, parking/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /The whole house/i }));
    expect(screen.getByPlaceholderText(/Keys, parking/i)).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
  });
});
