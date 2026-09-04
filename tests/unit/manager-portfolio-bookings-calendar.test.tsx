// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
}));

import { ManagerPortfolioBookingsCalendar } from "@/components/portal/manager-portfolio-bookings-calendar";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("ManagerPortfolioBookingsCalendar", () => {
  it("navigates to the next month and switches calendar views", async () => {
    render(
      <ManagerPortfolioBookingsCalendar
        propertyIds={["mgr-house-1"]}
        showToast={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("September 2026")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Next month"));
    expect(screen.getByText("October 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByText(/booked day/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(screen.getByText("2026")).toBeTruthy();
    expect(screen.getByText("September")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByText(/bookings this day/i)).toBeTruthy();
  });
});
