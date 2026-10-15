// @vitest-environment jsdom
/**
 * Day popup ⋯ (PLAN-0922-1013, `docs/agents/record-page.md`): every booking card gets
 * Edit booking + the one removal vocabulary (`bookingCancelLabel`: "Cancel booking" for a
 * named hold, "Delete reservation" for a marked one), and the removal hands the entry to the
 * SAME router the list row and the Edit sheet use — so the word always names what happens, a
 * named hold is soft-cancelled rather than hard-deleted, and the day pop-up offers neither
 * more nor less than the list row for the same booking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { BookingsDayPage } from "@/components/portal/bookings-day-page";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

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

  it("a manager-made hold gets Edit booking and Cancel booking", () => {
    render(
      <AppUiProvider>
        <BookingsDayPage
          dayKey="2026-09-20"
          basePath="/portal"
          entries={[hold]}
          loading={false}
          propertyOptions={propertyOptions}
          residentOptions={[]}
          onSaveBlock={async () => {}}
          onDeleteBlock={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    const menu = openMenu("Actions for Prakrit");
    expect(menu.textContent).toContain("Edit booking");
    expect(menu.textContent).toContain("Cancel booking");
    expect(menu.textContent).not.toContain("Edit dates");
    expect(menu.textContent).not.toContain("Remove booking");
  });

  it("Edit booking opens the edit sheet prefilled for that entry", () => {
    render(
      <AppUiProvider>
        <BookingsDayPage
          dayKey="2026-09-20"
          basePath="/portal"
          entries={[hold]}
          loading={false}
          propertyOptions={propertyOptions}
          residentOptions={[]}
          onSaveBlock={async () => {}}
          onDeleteBlock={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    const menu = openMenu("Actions for Prakrit");
    const editButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Edit booking")!;
    fireEvent.click(editButton);
    expect(document.querySelector('[data-attr="bookings-block-dates-modal"]')).not.toBeNull();
    // The day card is z-90 and Add booking is z-80 — leave the card mounted
    // and the schedule sits on top of the form (and two aria-modal layers
    // fight). Hide it for the whole edit.
    expect(document.querySelector('[data-attr="bookings-day-detail-modal"]')).toBeNull();
    const nameInput = document.querySelector('[data-attr="bookings-block-resident-name"]') as HTMLInputElement | null;
    // Editing an existing hold with a named resident lands on the "+ New
    // resident" fields already filled with their name (applyEditingBlock).
    expect(nameInput?.value).toBe("Prakrit");
  });

  it("Cancel booking on a named hold hands the entry to the shared router, never a hard delete", () => {
    const onDeleteBlock = vi.fn();
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
        onDeleteBlock={onDeleteBlock}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Prakrit");
    const removeButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Cancel booking")!;
    // Past the destructive-action settle window (RECORD_ACTION_DESTRUCTIVE_SETTLE_MS)
    // so this click is not the "stray synthetic tap right after opening" it guards against.
    vi.advanceTimersByTime(200);
    fireEvent.click(removeButton);

    expect(onDeleteBlock).toHaveBeenCalledWith(futureHold);
    expect(document.querySelector('[data-attr="bookings-day-delete-confirm"]')).toBeNull();
  });

  it("a marked reservation reads Delete reservation and goes to the same router", () => {
    const onDeleteBlock = vi.fn();
    const reservation: PropertyBookingEntry = {
      ...hold,
      summary: "Reserved",
      residentName: undefined,
      start: "2026-10-01",
      end: "2026-10-05",
    };
    render(
      <BookingsDayPage
        dayKey="2026-10-01"
        basePath="/portal"
        entries={[reservation]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onDeleteBlock={onDeleteBlock}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Blocked");
    expect(menu.textContent).toContain("Delete reservation");
    expect(menu.textContent).not.toContain("Cancel booking");
    const removeButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete reservation")!;
    vi.advanceTimersByTime(200);
    fireEvent.click(removeButton);
    expect(onDeleteBlock).toHaveBeenCalledWith(reservation);
  });

  it("an in-house-today hold reaches the same router, exactly as the list row does", () => {
    const onDeleteBlock = vi.fn();
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
        onDeleteBlock={onDeleteBlock}
        showToast={showToast}
      />,
    );
    const menu = openMenu("Actions for Prakrit");
    const removeButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Cancel booking")!;
    vi.advanceTimersByTime(200);
    fireEvent.click(removeButton);
    expect(onDeleteBlock).toHaveBeenCalledWith(hold);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("a signed-lease card jumps to the Lease record and has no removal action", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[signedLease]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    const menu = openMenu("Actions for Ada Lovelace");
    expect(menu.textContent).toContain("Open lease");
    expect(menu.textContent).not.toContain("Cancel booking");
    expect(menu.textContent).not.toContain("Delete reservation");
    const openLeaseButton = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Open lease")!;
    fireEvent.click(openLeaseButton);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toContain("lease-1");
  });

  it("does not put Add booking in the day dialog header", () => {
    render(
      <BookingsDayPage
        dayKey="2026-09-20"
        basePath="/portal"
        entries={[hold]}
        loading={false}
        propertyOptions={propertyOptions}
        residentOptions={[]}
        onSaveBlock={async () => {}}
        onDeleteBlock={() => {}}
        showToast={() => {}}
      />,
    );
    expect(document.querySelector('[data-attr="bookings-day-add"]')).toBeNull();
  });
});
