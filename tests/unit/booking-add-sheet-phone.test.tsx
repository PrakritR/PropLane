// @vitest-environment jsdom
/**
 * The "+ New resident" fields under Add booking take a phone alongside name
 * and email — captain's order: at least one of email/phone is required, both
 * are allowed, and the saved value is E.164 the same way the resident contact
 * card normalizes a phone (src/lib/phone-e164.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/lib/rental-application/data", () => ({
  getRoomOptionsForProperty: () => [{ value: "h1::r1", label: "Room 1" }],
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? null }),
}));

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: () => Promise.resolve([]),
  saveChannelCalendarConnection: () => Promise.resolve({ id: "c1" }),
  syncChannelCalendarConnection: () => Promise.resolve(),
  deleteChannelCalendarConnection: () => Promise.resolve(),
}));

import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";

const PROPERTY = [{ id: "h1", label: "4709A 8th Ave NE" }];

const attr = (view: ReturnType<typeof render>, name: string) =>
  view.container.ownerDocument.querySelector(`[data-attr="${name}"]`) as HTMLElement | null;

function open(onSave = vi.fn(() => Promise.resolve())) {
  const view = render(
    <BookingsBlockDatesModal
      open
      onClose={() => {}}
      propertyOptions={PROPERTY}
      initialPropertyId="h1"
      initialDayKey="2026-09-20"
      entries={[]}
      residentOptions={[]}
      onSave={onSave}
    />,
  );
  fireEvent.click(attr(view, "bookings-block-resident-new")!);
  return { view, onSave };
}

describe("Add booking — new resident phone", () => {
  afterEach(cleanup);

  it("renders a phone field alongside name and email", () => {
    const { view } = open();
    expect(attr(view, "bookings-block-resident-new-fields")).not.toBeNull();
    expect(attr(view, "bookings-block-resident-phone")).not.toBeNull();
  });

  it("refuses to save a name with neither email nor phone", () => {
    const { view } = open();
    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "Alex Rivera" } });
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves with only a phone (no email)", async () => {
    const { view, onSave } = open();
    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "Alex Rivera" } });
    const phoneInput = view.container.ownerDocument.querySelector(
      '[data-attr="bookings-block-resident-phone-number"]',
    ) as HTMLInputElement;
    expect(phoneInput).not.toBeNull();
    fireEvent.change(phoneInput, { target: { value: "2065550123" } });
    expect((attr(view, "bookings-block-dates-save") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      residentName: "Alex Rivera",
      residentEmail: "",
      residentPhone: "+12065550123",
      isNewResident: true,
    });
  });

  it("saves with both email and phone", async () => {
    const { view, onSave } = open();
    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "Alex Rivera" } });
    fireEvent.change(attr(view, "bookings-block-resident-email")!, { target: { value: "alex@example.com" } });
    const phoneInput = view.container.ownerDocument.querySelector(
      '[data-attr="bookings-block-resident-phone-number"]',
    ) as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "2065550123" } });

    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      residentName: "Alex Rivera",
      residentEmail: "alex@example.com",
      residentPhone: "+12065550123",
      isNewResident: true,
    });
  });

  it("shows the sheet's own result line and stays open after a new-resident invite", async () => {
    const onSave = vi.fn(() => Promise.resolve({ message: "Invite sent by text to (206) 555-0123." }));
    const { view } = open(onSave);
    fireEvent.change(attr(view, "bookings-block-resident-name")!, { target: { value: "Alex Rivera" } });
    const phoneInput = view.container.ownerDocument.querySelector(
      '[data-attr="bookings-block-resident-phone-number"]',
    ) as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "2065550123" } });

    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await vi.waitFor(() => expect(attr(view, "bookings-invite-result")).not.toBeNull());
    expect(attr(view, "bookings-invite-result")!.textContent).toContain("Invite sent by text");
    // The dialog is still mounted (never auto-closed) with a Done affordance.
    expect(attr(view, "bookings-block-dates-done")).not.toBeNull();
  });

  it("never marks picking an existing resident as a new one", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const view = render(
      <BookingsBlockDatesModal
        open
        onClose={() => {}}
        propertyOptions={PROPERTY}
        initialPropertyId="h1"
        initialDayKey="2026-09-20"
        entries={[]}
        residentOptions={[{ key: "email:maya@example.com", name: "Maya Zuneh", email: "maya@example.com", meta: "" }]}
        onSave={onSave}
      />,
    );
    fireEvent.click(attr(view, "bookings-block-dates-save")!);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ isNewResident: false });
  });
});
