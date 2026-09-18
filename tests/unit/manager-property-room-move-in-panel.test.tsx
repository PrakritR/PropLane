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
  it("puts Copy and Share as icons on The whole house", () => {
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
    expect(screen.getByRole("button", { name: "Copy to rooms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.getAllByPlaceholderText(/Keys, parking/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Copy to rooms$/i })?.textContent).not.toMatch(/Copy to rooms/);
  });

  it("keeps Copy disabled until house details are saved", () => {
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

    expect(screen.getByRole("button", { name: "Copy to rooms" })).toBeDisabled();
  });

  it("copies the resident House details link from the Share icon", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const showToast = vi.fn();

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

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0] ?? "")).toMatch(/\/resident\/move-in$/);
    expect(showToast).toHaveBeenCalledWith("Resident House details link copied.");
  });

  it("offers Share without Copy on an entire-home listing", () => {
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

    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy to rooms" })).toBeNull();
  });

  it("omits house icons when the manager cannot edit", () => {
    render(
      <ManagerPropertyRoomMoveInPanel
        sub={roomListing()}
        saveTarget={{ mode: "listing", saveId: "mgr-test" }}
        managerUserId="mgr-1"
        canEdit={false}
        onUpdated={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByText(/The whole house/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy to rooms" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
