// @vitest-environment jsdom
/**
 * Day popup ⋯ (PLAN-0922-1013, `docs/agents/record-page.md`): every
 * booking card gets Edit booking + Delete booking. Delete confirms in the
 * PortalDialog shape (destructive red primary, "Keep" secondary) and refuses
 * outright for an in-house active tenancy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { BookingsDayPage } from "@/components/portal/bookings-day-page";

const propertyOptions = [{ id: "p1", label: "5257 Brooklyn Ave" }];

const hold: PropertyBookingEntry = {
  source: "block",
  propertyId: "p1",
  propertyLabel: "5257 Brooklyn Ave",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Prakrit",
  start: "2026-09-20",
  end: "2026-09-25",
  statusLabel: "Held",
  blockId: "block-1",
  residentName: "Prakrit",
};

const signedLease: PropertyBookingEntry = {
  source: "proplane",
  propertyId: "p1",
  propertyLabel: "5257 Brooklyn Ave",
  roomId: "r2",
  roomLabel: "Room 2",
  summary: "Ada Lovelace",
  start: "2026-09-20",
  end: "2026-09-30",
  statusLabel: "Signed",
  leaseId: "lease-1",
};

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "ArrowDown" });
  return document.body.querySelector('[data-attr="record-actions-menu"]')!;
}

describe("BookingsDayPage — card actions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    navigate.mockClear();
  });

  it("a manager-made hold gets Edit booking and Delete booking", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[hold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Prakrit · Room 1");
    expect(menu.textContent).toContain("Edit booking");
    expect(menu.textContent).toContain("Delete booking");
    expect(menu.textContent).not.toContain("Edit dates");
    expect(menu.textContent).not.toContain("Cancel booking");
  });

  it("Edit booking opens the edit sheet prefilled for that entry", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[hold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Prakrit · Room 1");
    const editButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Edit booking")!;
    fireEvent.click(editButton);
    expect(document.querySelector('[data-attr="bookings-block-dates-modal"]')).not.toBeNull();
    const nameInput = document.querySelector('[data-attr="bookings-block-resident-name"]') as HTMLInputElement | null;
    // Editing an existing hold with a named resident lands on the "+ New
    // resident" fields already filled with their name (applyEditingBlock).
    expect(nameInput?.value).toBe("Prakrit");
  });

  it("Delete booking on a hold OUTSIDE today's stay opens the confirm dialog and, on confirm, deletes", async () => {
    const onRemoveBlock = vi.fn().mockResolvedValue(undefined);
    const futureHold: PropertyBookingEntry = { ...hold, start: "2026-10-01", end: "2026-10-05" };
    render(
      <BookingsDayPage
        dayKey="2026-10-01"
        basePath="/portal"
        entries={[futureHold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={onRemoveBlock}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Prakrit · Room 1");
    const deleteButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete booking")!;
    // Past the destructive-action settle window (RECORD_ACTION_DESTRUCTIVE_SETTLE_MS)
    // so this click is not the "stray synthetic tap right after opening" it guards against.
    vi.advanceTimersByTime(200);
    fireEvent.click(deleteButton);

    const dialog = document.querySelector('[data-attr="bookings-day-delete-confirm"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Keep");
    expect(dialog.textContent).toContain("Delete");

    const primary = document.querySelector('[data-attr="bookings-day-delete-confirm-primary"]') as HTMLElement;
    fireEvent.click(primary);
    await vi.waitFor(() => expect(onRemoveBlock).toHaveBeenCalledWith("block-1"));
  });

  it("Keep dismisses the confirm dialog without deleting", () => {
    const onRemoveBlock = vi.fn();
    const futureHold: PropertyBookingEntry = { ...hold, start: "2026-10-01", end: "2026-10-05" };
    render(
      <BookingsDayPage
        dayKey="2026-10-01"
        basePath="/portal"
        entries={[futureHold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={onRemoveBlock}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Prakrit · Room 1");
    const deleteButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete booking")!;
    vi.advanceTimersByTime(200);
    fireEvent.click(deleteButton);
    const keepButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Keep")!;
    fireEvent.click(keepButton);
    expect(onRemoveBlock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-attr="bookings-day-delete-confirm"]')).toBeNull();
  });

  it("refuses to delete an in-house-today booking instead of opening the confirm dialog", () => {
    const onRemoveBlock = vi.fn();
    const showToast = vi.fn();
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[hold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={onRemoveBlock}
        showToast={showToast}
      />,
    );
    const menu = openMenu("Actions for Prakrit · Room 1");
    const deleteButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete booking")!;
    vi.advanceTimersByTime(200);
    fireEvent.click(deleteButton);
    expect(document.querySelector('[data-attr="bookings-day-delete-confirm"]')).toBeNull();
    expect(onRemoveBlock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("in-house today"));
  });

  it("a signed-lease card jumps to the Lease record and has no Delete booking", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[signedLease]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Ada Lovelace · Room 2");
    expect(menu.textContent).toContain("Open lease");
    expect(menu.textContent).not.toContain("Delete booking");
    const openLeaseButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Open lease")!;
    fireEvent.click(openLeaseButton);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toContain("lease-1");
  });

  it('"Add booking" still sits in the day dialog header', () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[hold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onRemoveBlock={async () => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-add"]')).not.toBeNull();
  });
});
