// @vitest-environment jsdom
/**
 * The Block dates sheet can hold a room FOR someone: pick a resident already
 * on the books, or add a new one inline without leaving the sheet. The primary
 * button sits bottom-right like every other PropLane dialog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", () => ({
  getRoomOptionsForProperty: () => [{ value: "h1::r1", label: "Room 1" }],
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? null }),
}));

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  fetchOccupancySnapshot: () => Promise.resolve({ days: [] }),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));

import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";
import { RECORD_ACTION_DESTRUCTIVE_SETTLE_MS } from "@/components/ui/record-action-menu";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const PROPERTY = [{ id: "h1", label: "4709A 8th Ave NE" }];
const RESIDENTS = [
  { key: "email:maya@example.com", name: "Maya Zuneh", email: "maya@example.com", meta: "Room 3 · 4709A 8th Ave NE" },
];

function open(onSave = vi.fn(() => Promise.resolve())) {
  const view = render(
    <AppUiProvider>
      <BookingsBlockDatesModal
        open
        onClose={() => {}}
        propertyOptions={PROPERTY}
        initialPropertyId="h1"
        initialDayKey="2026-09-20"
        entries={[]}
        residentOptions={RESIDENTS}
        onSave={onSave}
      />
    </AppUiProvider>,
  );
  return { view, onSave };
}

function goToProperty() {
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-property"]')!);
}

function goToReview() {
  fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-review"]')!);
}

const attr = (view: ReturnType<typeof render>, name: string) =>
  view.container.ownerDocument.querySelector(`[data-attr="${name}"]`) as HTMLElement | null;

/** The portal select is a trigger + listbox, not a native `<select>`. */
function pick(trigger: HTMLElement, value: string) {
  fireEvent.click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = listbox.querySelector(`[data-field-select-option-value="${value}"]`)!;
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}
function optionLabels(trigger: HTMLElement): string[] {
  fireEvent.click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const labels = [...listbox.querySelectorAll('[role="option"]')].map((o) => (o.textContent ?? "").replace(/^✓/, "").trim());
  fireEvent.click(trigger);
  return labels;
}

describe("BookingsBlockDatesModal — resident", () => {
  // The dialog portals into document.body; without this the next test finds the previous sheet.
  afterEach(() => {
    cleanup();
    clearAllWorkspaceDrafts();
  });

  it("does not leave Property or Room as orphan <label>s", () => {
    const { view } = open();
    goToProperty();
    const orphans = [...view.container.ownerDocument.querySelectorAll("label")].filter((label) => {
      const associated = Boolean(label.htmlFor && view.container.ownerDocument.getElementById(label.htmlFor));
      const nested = Boolean(label.querySelector("input, textarea, select"));
      return !associated && !nested;
    });
    expect(orphans.map((label) => (label.textContent ?? "").trim())).toEqual([]);
    expect(attr(view, "bookings-block-property")).not.toBeNull();
    expect(attr(view, "bookings-block-room")).not.toBeNull();
  });

  it("puts Add booking on the workspace footer, bottom-right", () => {
    const { view } = open();
    expect(attr(view, "listing-v2-rail-property")).not.toBeNull();
    expect(attr(view, "bookings-block-dates-next")).not.toBeNull();
    goToReview();
    const button = attr(view, "bookings-block-dates-save")!;
    // Back and the primary button share the footer's right-hand group.
    const group = button.parentElement!;
    const footer = group.parentElement!;
    expect(footer.className).toContain("justify-between");
    expect(footer.className).not.toContain("justify-start");
    expect(footer.lastElementChild).toBe(group);
    expect(group.lastElementChild).toBe(button);
  });

  it("will not save until a resident is picked or the room is closed with a reason, then saves the picked resident's name and email", async () => {
    const { view, onSave } = open();
    goToReview();
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);

    goToProperty();
    const select = attr(view, "bookings-block-resident")!;
    expect(optionLabels(select)).toEqual([
      "Select resident",
      "Maya Zuneh · Room 3 · 4709A 8th Ave NE",
      "+ New resident…",
      "Closed (no guest)",
    ]);
    pick(select, "email:maya@example.com");
    goToReview();
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ residentName: "Maya Zuneh", residentEmail: "maya@example.com" });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty("blockKind");
  });

  it("Closed (no guest) needs a reason, refuses the import markers, and saves blockKind closed with no name", async () => {
    const { view, onSave } = open();
    goToProperty();
    pick(attr(view, "bookings-block-resident")!, "__closed__");
    const reason = attr(view, "bookings-block-closed-reason")!;
    goToReview();
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);

    goToProperty();
    fireEvent.change(reason, { target: { value: "Airbnb" } });
    goToReview();
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);

    goToProperty();
    fireEvent.change(reason, { target: { value: "Painting" } });
    goToReview();
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ residentName: "", residentEmail: "", reason: "Painting", blockKind: "closed" });
  });

  it("+ New resident reveals inline fields, needs a name, and saves the typed person", async () => {
    const { view, onSave } = open();
    goToProperty();
    fireEvent.click(attr(view, "bookings-block-resident-new")!);
    expect(attr(view, "bookings-block-resident-new-fields")).not.toBeNull();
    expect(attr(view, "bookings-block-resident")).toBeNull();

    // Empty name: Review refuses rather than saving a nameless "new" person.
    goToReview();
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);

    goToProperty();
    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "  Alex Rivera " } });
    fireEvent.change(attr(view, "bookings-block-resident-email")!, { target: { value: "Alex@Example.com" } });
    goToReview();
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ residentName: "Alex Rivera", residentEmail: "alex@example.com" });
  });

  it("'Pick from list instead' returns to the select with no one chosen", () => {
    const { view } = open();
    goToProperty();
    fireEvent.click(attr(view, "bookings-block-resident-new")!);
    fireEvent.click(attr(view, "bookings-block-resident-pick-list")!);
    expect(attr(view, "bookings-block-resident")!.textContent).toContain("Select resident");
  });

  it("labels the form Property, Move in, and Move out under Add booking", () => {
    const { view } = open();
    expect(document.body.textContent ?? "").toContain("Add booking");
    goToProperty();
    expect(document.body.textContent ?? "").toContain("Property");
    expect(document.body.textContent ?? "").toContain("Resident");
    expect(attr(view, "bookings-block-property")).not.toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-v2-rail-when"]')!);
    expect(document.body.textContent ?? "").toContain("Move in");
    expect(document.body.textContent ?? "").toContain("Move out");
    expect(document.body.textContent ?? "").not.toContain("Check-in");
    expect(document.body.textContent ?? "").not.toContain("Check-out");
    expect(attr(view, "bookings-block-check-in")).not.toBeNull();
    expect(attr(view, "bookings-block-check-out")).not.toBeNull();
  });

  it("is the Add task workspace — Property on the rail, no Reason section", () => {
    const { view } = open();
    const body = document.body.textContent ?? "";
    expect(attr(view, "listing-v2-rail-booking")).toBeNull();
    expect(attr(view, "bookings-block-reason")).toBeNull();
    expect(attr(view, "listing-v2-rail-property")).not.toBeNull();
    expect(attr(view, "listing-v2-rail-when")).not.toBeNull();
    expect(attr(view, "listing-v2-rail-review")).not.toBeNull();
    expect(attr(view, "bookings-sheet-pane-block")).toBeNull();
    expect(attr(view, "bookings-sheet-pane-airbnb")).toBeNull();
    expect(attr(view, "channel-calendar-link-import-url")).toBeNull();
    expect(body).not.toContain("Close a room to new bookings");
    expect(body).not.toContain("optional");
    expect(body).not.toContain("Puts their name on the hold");
    expect(body).not.toMatch(/\bReason\b/);
  });

  const SEP_HOLD = {
    source: "block" as const,
    propertyId: "h1",
    propertyLabel: "4709A 8th Ave NE",
    roomId: "r1",
    roomLabel: "Room 1",
    summary: "Sep hold",
    start: "2026-09-20",
    end: "2026-09-21",
    statusLabel: "Blocked",
    blockId: "block-1",
    reason: "Repairs",
  };

  function openHoldList(extra: Partial<React.ComponentProps<typeof BookingsBlockDatesModal>>, entry = SEP_HOLD) {
    const view = render(
      <AppUiProvider>
      <BookingsBlockDatesModal
        open
        onClose={() => {}}
        propertyOptions={PROPERTY}
        initialPropertyId="h1"
        entries={[entry]}
        residentOptions={RESIDENTS}
        onSave={async () => {}}
        {...extra}
      />
      </AppUiProvider>,
    );
    goToReview();
    return view;
  }

  async function holdMenu() {
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Sep 20/i }), { key: "ArrowDown" });
    // Past the destructive-action settle window, so the click below is not the stray synthetic tap it guards against.
    await new Promise((resolve) => setTimeout(resolve, RECORD_ACTION_DESTRUCTIVE_SETTLE_MS + 20));
    return document.body.querySelector('[data-attr="record-actions-menu"]')!;
  }

  it("lists existing holds with Edit dates and the router's own label, not a Blocked or View pill", async () => {
    const onRemoveBooking = vi.fn();
    const view = openHoldList({ onRemoveBooking });
    expect(attr(view, "bookings-sheet-existing-blocks")).not.toBeNull();
    const menu = await holdMenu();
    expect(menu.textContent).toContain("Edit");
    // Nobody attached, so the hold list says what the removal does: a hard Delete, not a cancel.
    expect(menu.textContent).toContain("Delete reservation");
    expect(menu.textContent).not.toContain("Cancel booking");
    expect(menu.textContent).not.toContain("View");
    expect(menu.textContent).not.toContain("Blocked");
    fireEvent.click([...menu.querySelectorAll("button")].find((b) => b.textContent === "Delete reservation")!);
    expect(onRemoveBooking).toHaveBeenCalledWith(SEP_HOLD);
  });

  it("offers no removal for a block the shared gate refuses", () => {
    const onRemoveBooking = vi.fn();
    // Cancelled: `canRemoveBooking` is false, so the hold list stays silent instead of opening a
    // dialog that would unblock a row whose item says Delete.
    openHoldList({ onRemoveBooking }, { ...SEP_HOLD, bookingStatus: "cancelled" });
    expect(screen.queryByRole("button", { name: /Actions for Sep 20/i })).toBeNull();
    expect(document.body.textContent).not.toContain("Delete reservation");
    expect(onRemoveBooking).not.toHaveBeenCalled();
  });

  it("keeps Quick book's legacy delete-by-id, untouched by the router", async () => {
    const onDeleteBlock = vi.fn().mockResolvedValue(true);
    openHoldList({ onDeleteBlock });
    const menu = await holdMenu();
    expect(menu.textContent).toContain("Cancel booking");
    fireEvent.click([...menu.querySelectorAll("button")].find((b) => b.textContent === "Cancel booking")!);
    expect(onDeleteBlock).toHaveBeenCalledWith("block-1");
  });
});

describe("BookingsBlockDatesModal — Quick book prefill", () => {
  afterEach(() => {
    cleanup();
    clearAllWorkspaceDrafts();
  });

  function openPrefilled(extra: Partial<React.ComponentProps<typeof BookingsBlockDatesModal>>) {
    const onSave = vi.fn(() => Promise.resolve());
    const view = render(
      <AppUiProvider>
        <BookingsBlockDatesModal
          open
          mode="reserve"
          onClose={() => {}}
          propertyOptions={PROPERTY}
          initialPropertyId="h1"
          initialRoomId="r1"
          initialDayKey="2026-11-01"
          entries={[]}
          residentOptions={RESIDENTS}
          onSave={onSave}
          {...extra}
        />
      </AppUiProvider>,
    );
    return { view, onSave };
  }

  async function saveDraft(view: ReturnType<typeof render>, onSave: ReturnType<typeof vi.fn>) {
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    return onSave.mock.calls[0]![0];
  }

  it("honours initialCheckOut, initialReason and a new resident", async () => {
    const { view, onSave } = openPrefilled({
      initialCheckOut: "2026-12-01",
      initialReason: "Application AXIS-1",
      initialResident: { name: "Pat Lee", email: "pat@example.com", phone: "+18146793694" },
    });
    expect(await saveDraft(view, onSave)).toMatchObject({
      propertyId: "h1",
      roomId: "r1",
      checkIn: "2026-11-01",
      checkOut: "2026-12-01",
      reason: "Application AXIS-1",
      residentName: "Pat Lee",
      residentEmail: "pat@example.com",
      isNewResident: true,
    });
  });

  it("matches an existing resident by email instead of adding a new one", async () => {
    const { view, onSave } = openPrefilled({ initialResident: { name: "Maya", email: "MAYA@example.com" } });
    expect(await saveDraft(view, onSave)).toMatchObject({ residentName: "Maya Zuneh", residentEmail: "maya@example.com" });
  });

  it("keeps the day-after check-out when no check-out or reason is passed", async () => {
    const { view, onSave } = openPrefilled({ initialResident: { name: "Maya", email: "MAYA@example.com" } });
    expect(await saveDraft(view, onSave)).toMatchObject({ checkOut: "2026-11-02", reason: "", residentName: "Maya Zuneh" });
  });

  it("will not save while the Bookings reads are still out — the collision check is the empty list", async () => {
    const { view, onSave } = openPrefilled({
      readsPending: true,
      initialResident: { name: "Maya", email: "MAYA@example.com" },
    });
    const save = attr(view, "bookings-block-dates-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(attr(view, "bookings-block-reads-pending")).toBeTruthy();
  });

  it("survives the Bookings reads landing after it opens: edits stand, a late resident still matches", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const sheet = (residents: typeof RESIDENTS) => (
      <AppUiProvider>
        <BookingsBlockDatesModal
          open
          mode="reserve"
          onClose={() => {}}
          // Both lists are memos in the real host: a fresh array identity every time a read lands.
          propertyOptions={[...PROPERTY]}
          initialPropertyId="h1"
          initialRoomId="r1"
          initialDayKey="2026-11-01"
          initialCheckOut="2026-12-01"
          initialResident={{ name: "Maya", email: "MAYA@example.com" }}
          entries={[]}
          residentOptions={residents}
          onSave={onSave}
        />
      </AppUiProvider>
    );
    const view = render(sheet([]));
    fireEvent.click(attr(view, "listing-v2-rail-when")!);
    fireEvent.change(attr(view, "bookings-block-check-out")!, { target: { value: "2026-12-15" } });

    view.rerender(sheet([...RESIDENTS]));

    fireEvent.click(attr(view, "listing-v2-rail-review")!);
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      checkOut: "2026-12-15",
      residentName: "Maya Zuneh",
      residentEmail: "maya@example.com",
    });
  });
});
