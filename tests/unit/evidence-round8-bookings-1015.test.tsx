// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the landed Bookings sub-branch work (2026-10-15).
//
// Renders the REAL Bookings surfaces and captures each one as a full HTML page under
// EVIDENCE_DIR so `tests/browser/round8-land-1015.config.ts` can paint them with the
// app's own Tailwind build. The assertions are the branch's contract:
//
//   1. The calendar bar's pop-over is NON-MODAL — no backdrop, and the page is never
//      left with `pointer-events: none` (the freeze the branch fixed).
//   2. Removal vocabulary and routing: a reservation with nobody attached says
//      "Delete reservation" and goes to the hard Delete confirm; a hold held for a
//      named person says "Cancel booking" and goes to the undoable cancel dialog.
//      Both come off the ONE router (`canDeleteReservation`) the day pop-up, the list
//      row and the Edit sheet all hand their entry to.
//   3. The Edit sheet is the AddWorkspace-based sheet: Where / When / Label for a
//      reservation, plus Guest / Rate / Stay details for a named booking.
//   4. A channel stay's record header carries "Open in Airbnb" as an icon action.
import { useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) =>
      propertyId === "p1" ? [{ value: "p1::room-1", label: "Room 1" }, { value: "p1::room-2", label: "Room 2" }] : [],
  };
});

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { BookingsCancelDialog } from "@/components/portal/bookings-cancel-dialog";
import { BookingsDayPage } from "@/components/portal/bookings-day-page";
import { BookingsDeleteBlockDialog } from "@/components/portal/bookings-delete-block-dialog";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";
import { bookingCancelLabel, canDeleteReservation } from "@/lib/channel-calendar/booking-presentation";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; caption: string; html: string }[] = [];

/** The whole body: a pop-over, a ⋯ menu and a dialog all render into a portal, not the container. */
function capture(name: string, caption: string) {
  captured.push({ name, caption, html: document.body.innerHTML });
}

afterAll(() => {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, caption, html } of captured) {
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.html`),
      `<!doctype html><html lang="en" data-theme="light" class="h-full antialiased">
<head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="position:relative;z-index:2147483647;font:600 13px/1.5 system-ui;color:#475569;margin:12px 16px;max-width:1100px;white-space:pre-line">${caption}</p>
${html}</body></html>`,
      "utf8",
    );
  }
});

const TODAY = new Date(2026, 9, 15); // 2026-10-15, the day this landed

/** Dates the manager marked reserved: nobody attached. */
const reservation: PropertyBookingEntry = {
  source: "block",
  propertyId: "p1",
  propertyLabel: "5259 Brooklyn Ave",
  roomId: "room-1",
  roomLabel: "Room 1",
  summary: "Reserved",
  reason: "Reserved",
  start: "2026-10-18",
  end: "2026-10-21",
  blockId: "block-res",
  bookingStatus: "confirmed",
};

/** The same shape of block, but held for a named person. */
const namedHold: PropertyBookingEntry = {
  ...reservation,
  roomId: "room-2",
  roomLabel: "Room 2",
  summary: "Maya Chen",
  reason: "",
  blockId: "block-hold",
  bookingStatus: "hold",
  residentName: "Maya Chen",
  residentEmail: "maya@example.test",
};

const airbnbStay: PropertyBookingEntry = {
  source: "airbnb",
  propertyId: "p1",
  propertyLabel: "5259 Brooklyn Ave",
  roomId: "room-3",
  roomLabel: "Room 3",
  summary: "Reserved",
  start: "2026-10-16",
  end: "2026-10-19",
  connectionId: "conn-1",
  sourceUid: "1418fb94@airbnb.com",
  reservationCode: "HM8F9S4DWC",
};

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00"));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.style.pointerEvents = "";
});

const noop = async () => {};
const propertyOptions = [{ id: "p1", label: "5259 Brooklyn Ave" }];

describe("evidence · the calendar bar's pop-over does not freeze the page", () => {
  it("opens with no backdrop and leaves the page clickable", async () => {
    render(
      <BookingsPortfolioTimeline
        propertyIds={["p1"]}
        entries={[reservation]}
        today={TODAY}
        onEditBooking={() => {}}
        onDeleteBlock={() => {}}
        onUnblockBooking={() => {}}
      />,
    );
    const bar = document.querySelector('[data-attr="bookings-calendar-bar"]') as HTMLElement;
    fireEvent.pointerDown(bar, { button: 0, ctrlKey: false });
    await screen.findByRole("menuitem", { name: "Delete" });
    // The branch's fix: a non-modal pop-over. A modal one locked the body and the next click did nothing.
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.querySelector('[data-testid="dropdown-menu-backdrop"]')).toBeNull();
    capture(
      "04-bookings-bar-popover",
      "Manager → Bookings → calendar. Clicking a bar opens its pop-over non-modally: no backdrop is painted and the body is never set to pointer-events: none, so the calendar behind it stays clickable — the freeze that used to need a reload.",
    );
  });
});

describe("evidence · one removal vocabulary, one router", () => {
  function dayPage(entries: PropertyBookingEntry[], onRemove: (entry: PropertyBookingEntry) => void) {
    return render(
      <AppUiProvider>
        <BookingsDayPage
          dayKey="2026-10-18"
          basePath="/portal"
          entries={entries}
          loading={false}
          propertyOptions={propertyOptions}
          residentOptions={[]}
          onSaveBlock={noop}
          onDeleteBlock={onRemove}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
  }

  /** The row's ⋯ (its accessible name is "Actions for <the row's own status/name>"). */
  function openMenu() {
    const trigger = document.querySelector('[data-attr="record-actions-trigger"]') as HTMLElement;
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    return document.body.querySelector('[data-attr="record-actions-menu"]')!;
  }

  /** Past RECORD_ACTION_DESTRUCTIVE_SETTLE_MS, so the click is not the stray tap the menu guards against. */
  const settle = () => vi.setSystemTime(new Date("2026-10-15T12:00:01"));

  it("a reservation with nobody attached says Delete reservation", () => {
    const routed: PropertyBookingEntry[] = [];
    dayPage([reservation], (entry) => routed.push(entry));
    const menu = openMenu();
    expect(menu.textContent).toContain("Delete reservation");
    expect(menu.textContent).not.toContain("Cancel booking");
    capture(
      "05-bookings-day-menu-reservation",
      "Manager → Bookings → a day's pop-up → ⋯ on dates marked reserved (nobody attached). The destructive action is worded for what actually happens: \"Delete reservation\".",
    );
    settle();
    fireEvent.click([...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete reservation")!);
    expect(routed).toHaveLength(1);
    expect(canDeleteReservation(routed[0]!)).toBe(true);
  });

  it("a hold held for a named person says Cancel booking", () => {
    const routed: PropertyBookingEntry[] = [];
    dayPage([namedHold], (entry) => routed.push(entry));
    const menu = openMenu();
    expect(menu.textContent).toContain("Cancel booking");
    expect(menu.textContent).not.toContain("Delete reservation");
    capture(
      "06-bookings-day-menu-named-hold",
      "The same ⋯, on the same kind of block — but this one is held for Maya Chen. It reads \"Cancel booking\": the undoable cancel that frees the nights and can tell the guest, never a hard delete.",
    );
    settle();
    fireEvent.click([...menu.querySelectorAll("button")].find((b) => b.textContent === "Cancel booking")!);
    expect(routed).toHaveLength(1);
    expect(canDeleteReservation(routed[0]!)).toBe(false);
  });

  /**
   * The router, wired exactly as `pro-bookings.tsx` wires it (`deleteOrCancel`): the real
   * `canDeleteReservation` picking between the real two dialogs. The shots are the dialogs a
   * manager actually lands in from each ⋯.
   */
  function Router({ entry }: { entry: PropertyBookingEntry }) {
    const [deleteEntry, setDeleteEntry] = useState<PropertyBookingEntry | null>(null);
    const [cancelEntry, setCancelEntry] = useState<PropertyBookingEntry | null>(null);
    const deleteOrCancel = (candidate: PropertyBookingEntry) => {
      if (canDeleteReservation(candidate)) setDeleteEntry(candidate);
      else setCancelEntry(candidate);
    };
    return (
      <AppUiProvider>
        <button type="button" onClick={() => deleteOrCancel(entry)}>{bookingCancelLabel(entry)}</button>
        {deleteEntry ? <BookingsDeleteBlockDialog entry={deleteEntry} onClose={() => setDeleteEntry(null)} onDelete={noop} /> : null}
        {cancelEntry ? <BookingsCancelDialog entry={cancelEntry} onClose={() => setCancelEntry(null)} onSave={noop} /> : null}
      </AppUiProvider>
    );
  }

  it("Delete reservation lands in the hard Delete confirm", async () => {
    render(<Router entry={reservation} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete reservation" }));
    await screen.findByText("Delete this block?");
    expect(document.querySelector('[data-attr="bookings-delete-block-dialog"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-cancel-preview"]')).toBeNull();
    capture(
      "07-bookings-delete-reservation-dialog",
      "Where \"Delete reservation\" goes: the hard Delete confirm, naming the house, room and nights. Nobody is attached, so nothing is owed and nobody is told — it just leaves the calendar.",
    );
  });

  it("Cancel booking lands in the undoable cancel dialog", async () => {
    render(<Router entry={namedHold} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await screen.findByText("Cancel Maya Chen’s booking?");
    expect(document.querySelector('[data-attr="bookings-cancel-preview"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-delete-block-dialog"]')).toBeNull();
    capture(
      "08-bookings-cancel-booking-dialog",
      "Where \"Cancel booking\" goes: the cancel dialog for the named hold — what changes, the Notify guest choice, and an Undo right after. A different word and a different screen, off the one router both ⋯ menus call.",
    );
  });
});

describe("evidence · the Edit sheet", () => {
  const wrap = (node: React.ReactNode) => render(<AppUiProvider>{node}</AppUiProvider>);

  it("a reservation edits Where, When and Label, and deletes", () => {
    wrap(<BookingsEditSheet entry={reservation} entries={[reservation]} onClose={() => {}} onSave={noop} onDelete={() => {}} />);
    expect(screen.getByText("Edit reservation")).toBeTruthy();
    for (const section of ["where", "when", "label"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeTruthy();
    for (const section of ["guest", "rate", "details"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeNull();
    expect(screen.getByRole("button", { name: "Delete reservation" })).toBeTruthy();
    capture(
      "09-bookings-edit-sheet-reservation",
      "Manager → Bookings → Edit on dates marked reserved. The AddWorkspace-based sheet asks only what a reservation has — Where, When, Label — with no Guest, Rate, Status or native select, and its footer says \"Delete reservation\".",
    );
  });

  it("a named booking adds Guest, Rate and Stay details, and cancels", () => {
    wrap(<BookingsEditSheet entry={namedHold} entries={[namedHold]} onClose={() => {}} onSave={noop} onDelete={() => {}} />);
    expect(screen.getByText("Edit booking")).toBeTruthy();
    for (const section of ["guest", "where", "when", "rate", "details"]) expect(document.querySelector(`[data-section="${section}"]`)).toBeTruthy();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel booking" })).toBeTruthy();
    capture(
      "10-bookings-edit-sheet-named-booking",
      "The same sheet for the named hold: it grows Guest, Rate and Stay details because this booking has a person on it, and its footer says \"Cancel booking\" — the same two words, the same two destinations, as the ⋯.",
    );
  });
});

describe("evidence · a channel stay's record header", () => {
  it("carries Open in Airbnb as an icon action", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <AppUiProvider>
        <BookingsRecordPage
          bookingId={bookingEntryKey(airbnbStay)}
          basePath="/portal"
          entries={[airbnbStay]}
          loading={false}
          residentOptions={[]}
          onSaveBlock={noop}
          onRemoveBlock={noop}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
    const action = screen.getByRole("button", { name: "Open in Airbnb" });
    // Icon-only utility chrome: the word is the tooltip and the aria-label, never a labelled pill.
    expect(action.getAttribute("data-slot")).toBe("portal-icon-action");
    expect(action.textContent?.trim()).toBe("");
    capture(
      "11-bookings-record-header-airbnb",
      "Manager → Bookings → an Airbnb stay's record. The header carries \"Open in Airbnb\" as icon-only chrome beside Message and Remove from PropLane — the word is its tooltip and aria-label, and the link is rebuilt from the reservation code the feed carried, never from the feed's own URL.",
    );
    fireEvent.click(action);
    expect(open).toHaveBeenCalledWith("https://www.airbnb.com/hosting/reservations/details/HM8F9S4DWC", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
});
