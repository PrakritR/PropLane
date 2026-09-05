// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
}));

import { ManagerPortfolioBookingsCalendar } from "@/components/portal/pro-portfolio-bookings-calendar";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
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
    expect(screen.getByText("Booked nights")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Next month"));
    expect(screen.getByText("October 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Week" }));
    expect(screen.getByText(/booked day/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Year" }));
    expect(screen.getByText("September")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Day" }));
    expect(screen.getByText(/bookings this day/i)).toBeTruthy();
  });

  it("switches to the list hub when not calendar-only", async () => {
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

    const hubTabs = within(screen.getAllByRole("tablist", { name: "Bookings layout" })[0]!);
    fireEvent.click(hubTabs.getByRole("tab", { name: "List" }));
    expect(screen.getByText("All stays (0)")).toBeTruthy();
    expect(screen.getByText(/No stays in this view/i)).toBeTruthy();
  });

  it("hides the list hub toggle in calendar-only mode", async () => {
    render(
      <ManagerPortfolioBookingsCalendar
        propertyIds={["mgr-house-1"]}
        showToast={() => {}}
        calendarOnly
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("tablist", { name: "Bookings layout" })).toBeNull();
    expect(screen.getByText("September 2026")).toBeTruthy();
  });
});
