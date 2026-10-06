// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookingsEditSheet, bookingRoomChoices } from "@/components/portal/bookings-edit-sheet";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

// A property whose rooms are not configured falls back to its building's units: values with no `::roomId`.
const roomOptions = vi.hoisted(() => ({
  current: [] as { value: string; label: string }[],
}));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getRoomOptionsForProperty: () => roomOptions.current,
}));

const entry: PropertyBookingEntry = { source: "block", propertyId: "house", propertyLabel: "House", roomId: "", roomLabel: "", summary: "Guest", residentName: "Guest", residentEmail: "guest@example.test", blockId: "block-1", start: "2099-01-01", end: "2099-01-05", bookingStatus: "confirmed" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Opens the Room dropdown and reads its option labels. */
function roomOptionLabels(): string[] {
  const trigger = document.querySelector('[data-attr="select-booking-edit-room"]') as HTMLElement;
  fireEvent.click(trigger);
  return screen.getAllByRole("option").map((option) => option.textContent?.trim() ?? "");
}

describe("booking edit sheet select keys", () => {
  it("bookingRoomChoices drops id-less units and duplicate ids, so every choice id is unique and non-empty", () => {
    const choices = bookingRoomChoices(
      [
        { value: "unit-a", label: "Unit A" },
        { value: "unit-b", label: "Unit B" },
        { value: "house::r1", label: "Room 1" },
        { value: "house::r1", label: "Room 1 again" },
        { value: "house::r2", label: "Room 2" },
      ],
      (id) => (id === "r2" ? ["x"] : []),
    );
    expect(choices.map((choice) => choice.id)).toEqual(["r1", "r2"].sort((a, b) => Number(a === "r2") - Number(b === "r2")));
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(choices.length);
    expect(choices.every((choice) => choice.id !== "")).toBe(true);
  });

  it("renders without a duplicate-key warning and with unique option values", () => {
    roomOptions.current = [
      { value: "unit-a", label: "Unit A" },
      { value: "unit-b", label: "Unit B" },
      { value: "unit-c", label: "Unit C" },
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppUiProvider>
        <BookingsEditSheet entry={entry} entries={[entry]} onClose={() => {}} onSave={vi.fn()} />
      </AppUiProvider>,
    );
    expect(roomOptionLabels()).toEqual(["Whole home"]);
    const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
  });

  it("lists real rooms once each beside Whole home", () => {
    roomOptions.current = [
      { value: "house::r1", label: "Room 1" },
      { value: "house::r2", label: "Room 2" },
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppUiProvider>
        <BookingsEditSheet entry={entry} entries={[entry]} onClose={() => {}} onSave={vi.fn()} />
      </AppUiProvider>,
    );
    expect(roomOptionLabels()).toEqual(["Whole home", "Room 1", "Room 2"]);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("same key"))).toEqual([]);
  });
});
