// @vitest-environment jsdom
//
// The one Add availability popup (studio-redesign-0929 C2-CALA2, CALA5):
// Availability for / On / Days / Repeats / From / To / Properties, with the
// small week on the right showing the bands Save will create.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CalendarAvailabilityDialog } from "@/components/portal/calendar-availability-dialog";
import { ALL_HOUSES, type AvailabilityDraft } from "@/lib/calendar-availability-window";

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

function mockDesktopMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

const initial: AvailabilityDraft = {
  kinds: ["tours", "services", "tasks"],
  on: "days",
  weekdays: [0, 1, 2, 3, 4],
  date: "2026-10-05",
  repeat: "weekly",
  startSlot: 18,
  endSlotExclusive: 34,
  propertyIds: [ALL_HOUSES],
  weekMonday: "2026-10-05",
};

const houses = [
  { id: "p1", label: "Alder House" },
  { id: "p2", label: "Maple Duplex" },
];

function mount(over: Partial<React.ComponentProps<typeof CalendarAvailabilityDialog>> = {}) {
  mockDesktopMatchMedia();
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const utils = render(
    <CalendarAvailabilityDialog
      open
      onClose={() => {}}
      initial={initial}
      editing={false}
      propertyOptions={houses}
      onSave={onSave}
      onDelete={onDelete}
      {...over}
    />,
  );
  return { onSave, onDelete, ...utils };
}

describe("CalendarAvailabilityDialog", () => {
  it("is titled Your availability with a single labelled primary", () => {
    mount();
    const dialog = screen.getByRole("dialog", { name: "Your availability" });
    expect(within(dialog).getByText("Availability for")).toBeTruthy();
    expect(within(dialog).getAllByText("On").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Days")).toBeTruthy();
    expect(within(dialog).getByText("Repeats")).toBeTruthy();
    expect(within(dialog).getByText("From")).toBeTruthy();
    expect(within(dialog).getByText("To")).toBeTruthy();
    expect(within(dialog).getAllByText("Tours at").length).toBeGreaterThan(0);
    expect(screen.getByText("Add availability", { selector: "button" })).toBeTruthy();
    // dropdowns, not raw selects
    expect(dialog.querySelectorAll("select")).toHaveLength(0);
  });

  it("previews a week with a band on each picked day, 'Every week', and the facts", () => {
    mount();
    const preview = document.querySelector('[data-attr="calendar-availability-preview"]')!;
    expect(preview.querySelectorAll('[data-attr="calendar-availability-preview-band"]')).toHaveLength(5);
    expect(preview.querySelector('[data-attr="calendar-availability-preview-caption"]')?.textContent).toBe("Every week");
    expect(preview.textContent).toContain("Tours, Services, Tasks");
    expect(preview.textContent).toContain("9 am – 5 pm");
    expect(preview.textContent).toContain("All houses");
  });

  it("offers exactly Tours, Services and Tasks, and asks for houses only for Tours", () => {
    mount({ initial: { ...initial, kinds: ["services", "tasks"] } });
    const dialog = screen.getByRole("dialog", { name: "Your availability" });
    expect(within(dialog).queryByText("Tours at")).toBeNull();
    expect(within(dialog).queryByText("Everything")).toBeNull();
    expect(within(dialog).queryByText("Inspections")).toBeNull();
    expect(within(dialog).queryByText("Move-ins and move-outs")).toBeNull();
  });

  it("previews 'This week only' with the week it applies to", () => {
    mount({ initial: { ...initial, repeat: "week", weekdays: [1] } });
    const preview = document.querySelector('[data-attr="calendar-availability-preview"]')!;
    expect(preview.querySelectorAll('[data-attr="calendar-availability-preview-band"]')).toHaveLength(1);
    expect(preview.querySelector('[data-attr="calendar-availability-preview-caption"]')?.textContent).toBe("Week of 2026-10-05");
  });

  it("a type is drawn with its stripe colour in the preview, all three kinds are the plain hatch", () => {
    mount({ initial: { ...initial, kinds: ["services"] } });
    const band = document.querySelector('[data-attr="calendar-availability-preview-band"]') as HTMLElement;
    expect(band.style.boxShadow).toContain("#eb6834");
    cleanup();
    mount();
    const plain = document.querySelector('[data-attr="calendar-availability-preview-band"]') as HTMLElement;
    expect(plain.style.boxShadow).toBe("");
  });

  it("Save hands back the draft", () => {
    const { onSave } = mount();
    fireEvent.click(screen.getByText("Add availability", { selector: "button" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kinds: ["tours", "services", "tasks"], startSlot: 18, endSlotExclusive: 34 });
  });

  it("an impossible form can't be saved and says why", () => {
    const { onSave } = mount({ initial: { ...initial, weekdays: [] } });
    const save = screen.getByText("Add availability", { selector: "button" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText("Pick at least one day")).toBeTruthy();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("editing a band reads Edit availability and offers Save and Delete", () => {
    const { onDelete } = mount({ editing: true, initial: { ...initial, on: "date", date: "2026-10-06", repeat: "week" } });
    expect(screen.getByRole("dialog", { name: "Your availability" })).toBeTruthy();
    expect(screen.getByText("Save", { selector: "button" })).toBeTruthy();
    fireEvent.click(screen.getByText("Delete", { selector: "button" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("re-seeds from the next band when it is reopened", () => {
    const { rerender } = mount();
    const other = { ...initial, weekdays: [2], repeat: "week" as const };
    rerender(
      <CalendarAvailabilityDialog
        open
        onClose={() => {}}
        initial={other}
        editing={false}
        propertyOptions={houses}
        onSave={() => {}}
      />,
    );
    const preview = document.querySelector('[data-attr="calendar-availability-preview"]')!;
    expect(preview.querySelectorAll('[data-attr="calendar-availability-preview-band"]')).toHaveLength(1);
  });
});
