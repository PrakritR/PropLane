// @vitest-environment jsdom
//
// The shared month grid: open days green, the manager's occupied dates red,
// booked spans grey (and grey wins where both cover a day), today ringed, and
// the prev arrow disabled on the first month.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoomAvailabilityMonthCalendar, roomCalendarDayTone } from "@/components/room-availability-month-calendar";

afterEach(() => cleanup());

const day = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("RoomAvailabilityMonthCalendar", () => {
  it("colours a day by the span that covers it, booked over occupied", () => {
    const spans = [
      { start: day(1), end: day(3), tone: "occupied" as const },
      { start: day(3), end: day(5), tone: "booked" as const },
    ];
    expect(roomCalendarDayTone(day(0), spans)).toBe("open");
    expect(roomCalendarDayTone(day(1), spans)).toBe("occupied");
    expect(roomCalendarDayTone(day(3), spans)).toBe("booked");
    expect(roomCalendarDayTone(day(5), spans)).toBe("booked");
  });

  it("renders the current month with today ringed, prev disabled, and a legend when asked", () => {
    const { container } = render(<RoomAvailabilityMonthCalendar spans={[{ start: day(0), end: day(0), tone: "occupied" }]} legend />);
    const today = container.querySelector(`[data-day="${key(day(0))}"]`);
    expect(today?.getAttribute("data-tone")).toBe("occupied");
    expect(today?.className).toContain("ring-primary");
    expect((screen.getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Calendar key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect((screen.getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
