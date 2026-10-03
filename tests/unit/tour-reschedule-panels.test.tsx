// @vitest-environment jsdom
//
// "Pick a new tour time" (studio-redesign-0929 C2-TR1, C2-POP4): two dropdowns
// (Day, Time) in a compact form card, the struck-through Current → New row, and
// side panes that follow each pick: who the tour is about, the updated tour card
// and the exact message the guest receives.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TourRescheduleContextCard, TourReschedulePreviewCard } from "@/components/portal/tour-reschedule-panels";
import type { ManagerTourRow } from "@/lib/manager-tour-list";

afterEach(cleanup);

const row: ManagerTourRow = {
  id: "t1",
  source: "planned",
  sourceId: "t1",
  guestName: "Casey Reyes",
  guestEmail: "casey@example.com",
  guestPhone: "",
  propertyTitle: "Alder House",
  roomLabel: "Room 2",
  whenLabel: "Sat, Sep 26, 10:00 AM",
  startIso: "2026-09-26T17:00:00.000Z",
  endIso: "2026-09-26T17:30:00.000Z",
  startMs: Date.parse("2026-09-26T17:00:00.000Z"),
  endMs: Date.parse("2026-09-26T17:30:00.000Z"),
  statusLabel: "Confirmed",
  tourFormat: "in_person",
  bucket: "upcoming",
};

describe("TourRescheduleContextCard", () => {
  it("says who the tour is about and its current time", () => {
    render(<TourRescheduleContextCard row={row} />);
    expect(screen.getByText("Casey Reyes")).toBeTruthy();
    expect(screen.getByText("Alder House · Room 2")).toBeTruthy();
    expect(screen.getByText(/^Current: /).textContent).toContain("Sat, Sep 26");
    expect(screen.getByText("CR")).toBeTruthy();
  });
});

describe("TourReschedulePreviewCard", () => {
  it("shows the new time, what it replaces, and the message the guest gets", () => {
    render(
      <TourReschedulePreviewCard
        row={row}
        newStartIso="2026-09-28T18:00:00.000Z"
        subject="Your PropLane tour has a new time"
        body="Hi Casey, your tour has a new time."
      />,
    );
    expect(screen.getByText("New time")).toBeTruthy();
    expect(screen.getByText("Was")).toBeTruthy();
    expect(screen.getByText("Guest receives")).toBeTruthy();
    expect(screen.getByText("Your PropLane tour has a new time")).toBeTruthy();
    expect(screen.getByText("Hi Casey, your tour has a new time.")).toBeTruthy();
    expect(screen.getByText("casey@example.com")).toBeTruthy();
  });

  it("says so when the chosen day has no open time, and shows no 'Was' for an unchanged pick", () => {
    const { rerender } = render(<TourReschedulePreviewCard row={row} newStartIso={null} subject="s" body="" />);
    expect(screen.getByText("No open times that day")).toBeTruthy();
    rerender(<TourReschedulePreviewCard row={row} newStartIso={row.startIso} subject="s" body="b" />);
    expect(screen.queryByText("Was")).toBeNull();
  });
});

describe("the picker itself", () => {
  const fields = readFileSync(join(process.cwd(), "src/components/portal/tour-reschedule-time-picker-fields.tsx"), "utf8");
  const tours = readFileSync(join(process.cwd(), "src/components/portal/pro-tours.tsx"), "utf8");

  it("is two dropdowns, Day and Time — not raw selects, not a chip strip or time grid", () => {
    expect(fields).toContain('label="Day"');
    expect(fields).toContain('label="Time"');
    expect(fields).toContain("FieldSingleSelect");
    expect(fields).not.toContain("<Select");
    expect(fields).not.toContain("<option");
    // Days with no open times are listed but disabled.
    expect(fields).toContain("disabled: opt.disabled");
    // Current is struck through, New follows the pick.
    expect(fields).toContain("line-through");
    expect(fields).toContain('data-attr="tour-reschedule-new"');
  });

  it("the popup carries the context pane and the updated-tour preview", () => {
    expect(tours).toContain("<TourRescheduleContextCard");
    expect(tours).toContain("<TourReschedulePreviewCard");
    expect(tours).toContain('previewLabel="UPDATED TOUR"');
  });

  it("the Calendar's Agenda ⋯ → Reschedule opens it once from ?reschedule=1", () => {
    expect(tours).toContain('params.get("reschedule") !== "1"');
    expect(tours).toContain("openReschedulePreview([detailRow])");
    expect(tours).toContain("rescheduleFlagHandled");
  });
});
