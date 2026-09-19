/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerPropertyRoomMoveInPanel } from "@/components/portal/pro-property-room-move-in-panel";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/lib/demo-property-pipeline", () => ({
  updateExtraListingFromSubmission: vi.fn(() => true),
  updatePendingManagerProperty: vi.fn(() => true),
}));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  updateRequestChangeProperty: vi.fn(() => true),
}));

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
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
  it("opens a room disclosure editor when its row is clicked", () => {
    const { container } = render(
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
    const roomDetails = container.querySelector(
      '[data-attr="property-move-in-room-room-b"] details',
    ) as HTMLDetailsElement;
    expect(roomDetails.open).toBe(false);

    fireEvent.click(roomDetails.querySelector("summary")!);

    expect(roomDetails.open).toBe(true);
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
  });

  it("collapses the room editor when its disclosure row is clicked again", () => {
    const { container } = render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    const roomDetails = container.querySelector(
      '[data-attr="property-move-in-room-room-b"] details',
    ) as HTMLDetailsElement;
    fireEvent.click(roomDetails.querySelector("summary")!);
    expect(roomDetails.open).toBe(true);
    expect(screen.getByDisplayValue("Lockbox on porch")).toBeTruthy();
    fireEvent.click(roomDetails.querySelector("summary")!);
    expect(roomDetails.open).toBe(false);
  });

  it("keeps house sharing in the disclosure header while room rows stay disclosure controls", async () => {
    const showToast = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={showToast}
      />,
    );

    fireEvent.click(screen.getByLabelText("Share house details"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/resident/move-in")),
    );
    expect(showToast).toHaveBeenCalledWith("Resident House details link copied.");
    expect(screen.getByText("Room B")).toBeTruthy();
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
  });

  it("toggles the whole-house disclosure independently from the room disclosures", () => {
    const { container } = render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    const houseDetails = container.querySelector(
      '[data-attr="property-move-in-house"]',
    ) as HTMLDetailsElement;
    expect(houseDetails.open).toBe(true);
    fireEvent.click(houseDetails.querySelector("summary")!);
    expect(houseDetails.open).toBe(false);
    expect(screen.queryByTestId("move-in-editor-save")).toBeNull();
  });

  it("offers whole-house sharing on an entire-home listing", () => {
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
    expect(screen.queryByLabelText("Share house details")).toBeNull();
  });
});
