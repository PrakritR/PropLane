// @vitest-environment jsdom
/**
 * The manager Calendar surface end to end inside PortalCalendarPanels
 * (studio-redesign-0929): hatched bands from the painted windows (C2-CALP3),
 * band types and tab filters (C2-CALA6), drag to add and what Save writes
 * (C2-CALA2/4), click a band to edit or delete it (C2-CALA5), Clear week and
 * Copy previous week on every type (C2-CALA7), the clock menu (C2-CALA1) and
 * the + menu (C2-CALP8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import {
  managerPropertyAvailabilityStorageKey,
  startOfWeekMonday,
  toLocalDateStr,
} from "@/lib/demo-admin-scheduling";
import { GRID_HOUR_PX } from "@/lib/calendar-grid";
import { managerKindAvailabilityStorageKey } from "@/lib/manager-availability-kinds";

/** Pointer offsets were written for 60 px hours; scale them to the real hour height. */
const yAt = (px60: number) => Math.round((px60 * GRID_HOUR_PX) / 60);
import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

const USER = "mgr-1";
const P1 = managerPropertyAvailabilityStorageKey(USER, "p1");
const P2 = managerPropertyAvailabilityStorageKey(USER, "p2");
const SERVICES = managerKindAvailabilityStorageKey(USER, "services");
const TASKS = managerKindAvailabilityStorageKey(USER, "tasks");
const INSPECTIONS = managerKindAvailabilityStorageKey(USER, "inspections");
const MOVES = managerKindAvailabilityStorageKey(USER, "moves");

let SLOTS: Record<string, Set<string>> = {};
const writes: Array<{ key: string; slots: string[] }> = [];

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "m@example.com", ready: true }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/calendar",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({ buildScheduledTourMeetings: () => [] }));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: vi.fn(async () => undefined),
    readAvailabilityDateSetForStorageKey: (key: string) => new Set(SLOTS[key] ?? []),
    readPlannedEvents: () => [],
    writeAvailabilityDateSetForStorageKeyToServer: async (next: Set<string>, key: string) => {
      writes.push({ key, slots: [...next].sort() });
      SLOTS[key] = new Set(next);
      return true;
    },
  };
});

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

const monday = startOfWeekMonday(new Date());
const day = (offset: number) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + offset);
  return toLocalDateStr(d);
};
const MON = day(0);
const TUE = day(1);
const NEXT_TUE = day(8);
const PREV_TUE = day(-6);

function everythingKeys(date: string, from: number, to: number) {
  const out: string[] = [];
  for (let slot = from; slot < to; slot += 1) out.push(`${date}:${slot}`);
  return out;
}

beforeEach(() => {
  SLOTS = {
    // Tue 1 to 4 pm is Tours only; Tue 9 to 11 am is Everything (every kind has it).
    [P1]: new Set([...everythingKeys(TUE, 26, 32), ...everythingKeys(TUE, 18, 22)]),
    [P2]: new Set(),
    [SERVICES]: new Set(everythingKeys(TUE, 18, 22)),
    [TASKS]: new Set(everythingKeys(TUE, 18, 22)),
    [INSPECTIONS]: new Set(everythingKeys(TUE, 18, 22)),
    [MOVES]: new Set(everythingKeys(TUE, 18, 22)),
  };
  writes.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
  );
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

function mockDesktop() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

function mount(tab: "all" | "tours" | "services" | "tasks" = "all", extra: Partial<React.ComponentProps<typeof PortalCalendarPanels>> = {}) {
  mockDesktop();
  return render(
    <PortalCalendarPanels
      storageKey={null}
      availabilityKeysByKind={{
        tours: [P1],
        services: [SERVICES],
        tasks: [TASKS],
      }}
      editKind="tours"
      compactAvailability
      bareSurface
      studioGrid
      calendarTab={tab}
      defaultViewMode="week"
      viewMode="week"
      hideViewModeControl
      scheduleTourPropertyOptions={[
        { id: "p1", label: "Alder House" },
        { id: "p2", label: "Maple Duplex" },
      ]}
      defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
      anchorDate={monday}
      {...extra}
    />,
  );
}

/** The viewer's own availability blocks (the hatch is only the implicit default now). */
const bandsOn = (date: string) =>
  [
    ...document.querySelectorAll(`[data-day="${date}"] [data-attr="calendar-availability-block"][data-own="true"]`),
  ] as HTMLElement[];

describe("bands from the painted windows", () => {
  it("draws Everything as the plain hatch and Tours-only as a tinted, named band", async () => {
    mount("all");
    await waitFor(() => expect(bandsOn(TUE).length).toBeGreaterThan(0));
    const bands = bandsOn(TUE);
    const plain = bands.find((b) => b.getAttribute("data-from") === String(18 * 30))!;
    const tours = bands.find((b) => b.getAttribute("data-from") === String(26 * 30))!;
    // All three kinds read as one block named for all three; Tours-only names just Tours. The old
    // inspections/moves records ride in on Tasks (merged on read).
    expect(plain.textContent).toContain("Tours, Services, Tasks");
    expect(tours.textContent).toContain("Tours");
    expect(tours.textContent).not.toContain("Services");
    // Pale in the person's colour: 12% tint, 45% border.
    expect(tours.style.background).toContain("12%");
    expect(tours.style.borderColor).toContain("45%");
  });

  it("the Tours tab keeps windows that include Tours; Tasks keeps windows that include Tasks (C2-CALA6)", async () => {
    mount("tours");
    await waitFor(() => expect(bandsOn(TUE)).toHaveLength(2));
    cleanup();
    mount("tasks");
    await waitFor(() => expect(bandsOn(TUE)).toHaveLength(1));
    expect(bandsOn(TUE)[0]!.textContent).toContain("Tours, Services, Tasks");
    cleanup();
    mount("services");
    await waitFor(() => expect(bandsOn(TUE)).toHaveLength(1));
  });

  it("names the types on screen in the legend", async () => {
    mount("all");
    await waitFor(() => expect(document.querySelector('[data-attr="calendar-legend"]')?.textContent).toContain("Tours"));
    expect(document.querySelector('[data-attr="calendar-legend"]')?.textContent).toContain("Tours, Services, Tasks");
  });
});

describe("drag to add, then Save", () => {
  it("opens Your availability with the day and times filled in, the kind of the view and This week only (C2-CALA4)", async () => {
    mount("all");
    const col = document.querySelector(`[data-day="${MON}"]`)!;
    // 8 am window start: 130 px = 10:10, 190 px = 11:10 → 10 to 11:30 am.
    fireEvent.pointerDown(col, { button: 0, pointerType: "mouse", pointerId: 1, clientY: yAt(130), clientX: 5 });
    fireEvent.pointerMove(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(190) });
    expect(document.querySelector('[data-attr="calendar-drag-ghost"]')?.textContent).toBe("10 – 11:30 am");
    fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(190) });
    const dialog = await screen.findByRole("dialog", { name: "Your availability" });
    expect(within(dialog).getAllByText("Tours").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Everything")).toBeNull();
    expect(dialog.textContent).toContain("This week only");
    expect(dialog.textContent).toContain("10 am");
    expect(dialog.textContent).toContain("11:30 am");
    expect(document.querySelectorAll('[data-attr="calendar-availability-preview-band"]')).toHaveLength(1);
  });

  it("Save writes Tours to every house, and only Tours (C2-CALA2)", async () => {
    mount("all");
    const col = document.querySelector(`[data-day="${MON}"]`)!;
    fireEvent.pointerDown(col, { button: 0, pointerType: "mouse", pointerId: 1, clientY: yAt(130), clientX: 5 });
    fireEvent.pointerMove(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(190) });
    fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(190) });
    const dialog = await screen.findByRole("dialog", { name: "Your availability" });
    fireEvent.click(within(dialog).getByText("Add availability", { selector: "button" }));
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2));
    const keys = writes.map((w) => w.key).sort();
    expect(keys).toEqual([P1, P2].sort());
    const slotKeys = ["20", "21", "22"].map((s) => `${MON}:${s}`);
    for (const write of writes) {
      for (const k of slotKeys) expect(write.slots).toContain(k);
    }
    // Nothing leaked into other days.
    expect(writes.find((w) => w.key === P2)!.slots).toHaveLength(3);
  });
});

describe("click a band to edit or delete it (C2-CALA5)", () => {
  it("opens Edit availability on a painted band with Save and Delete", async () => {
    mount("all");
    await waitFor(() => expect(bandsOn(TUE).length).toBeGreaterThan(0));
    const tours = bandsOn(TUE).find((b) => b.getAttribute("data-from") === String(26 * 30))!;
    fireEvent.click(tours);
    const dialog = await screen.findByRole("dialog", { name: "Your availability" });
    expect(within(dialog).getByText("Save", { selector: "button" })).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Delete", { selector: "button" }));
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    // Only the Tours key lost the 1 to 4 pm run; the Everything run is untouched.
    expect(writes.map((w) => w.key)).toEqual([P1]);
    expect(writes[0]!.slots.some((k) => k.startsWith(`${TUE}:26`))).toBe(false);
    expect(writes[0]!.slots).toContain(`${TUE}:18`);
  });

  it("Delete on an Everything band clears every kind for that run", async () => {
    mount("all");
    await waitFor(() => expect(bandsOn(TUE).length).toBeGreaterThan(0));
    fireEvent.click(bandsOn(TUE).find((b) => b.getAttribute("data-from") === String(18 * 30))!);
    const dialog = await screen.findByRole("dialog", { name: "Your availability" });
    fireEvent.click(within(dialog).getByText("Delete", { selector: "button" }));
    // Tours, Services and Tasks, plus the two retired task records the Tasks write folds in and empties.
    await waitFor(() => expect(writes.length).toBe(5));
    for (const write of writes) expect(write.slots.some((k) => k === `${TUE}:18`)).toBe(false);
    expect(writes.find((w) => w.key === P1)!.slots).toContain(`${TUE}:26`);
  });
});

describe("clock menu (C2-CALA1, CALA7)", () => {
  async function openMenu() {
    const trigger = await screen.findByRole("button", { name: "Availability" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
  }

  it("lists Add availability, Copy previous week, Clear week and Copy to houses — and no 'Edit tour availability'", async () => {
    mount("all", { otherProperties: [{ id: "p2", name: "Maple Duplex" }], onCopyWeekToHouses: () => {} });
    await openMenu();
    const menu = await screen.findByRole("menu");
    const labels = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(labels).toEqual(["Add availability", "Copy previous week", "Clear week", "Copy to houses"]);
    expect(screen.queryByText(/Edit tour availability/)).toBeNull();
    expect(screen.queryByText("Add availability block")).toBeNull();
  });

  it("Clear week removes this week's windows from every kind and leaves other weeks alone", async () => {
    SLOTS[P1] = new Set([...SLOTS[P1]!, ...everythingKeys(NEXT_TUE, 26, 32)]);
    mount("all");
    await openMenu();
    fireEvent.click(await screen.findByText("Clear week"));
    await waitFor(() => expect(writes.length).toBe(5));
    const p1 = writes.find((w) => w.key === P1)!;
    expect(p1.slots.filter((k) => k.startsWith(TUE))).toHaveLength(0);
    expect(p1.slots).toContain(`${NEXT_TUE}:26`);
  });

  it("Copy previous week brings last week's windows of any type into this week", async () => {
    SLOTS = {
      [P1]: new Set(everythingKeys(PREV_TUE, 20, 22)),
      [P2]: new Set(),
      [SERVICES]: new Set(everythingKeys(PREV_TUE, 24, 26)),
      [TASKS]: new Set(),
      [INSPECTIONS]: new Set(),
      [MOVES]: new Set(),
    };
    mount("all");
    await openMenu();
    fireEvent.click(await screen.findByText("Copy previous week"));
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2));
    expect(writes.find((w) => w.key === P1)!.slots).toEqual(
      expect.arrayContaining([`${PREV_TUE}:20`, `${TUE}:20`, `${TUE}:21`]),
    );
    expect(writes.find((w) => w.key === SERVICES)!.slots).toEqual(expect.arrayContaining([`${TUE}:24`, `${TUE}:25`]));
  });
});

async function headerPlus(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-attr="calendar-create-menu"]')).toBeTruthy());
  return document.querySelector('[data-attr="calendar-create-menu"]') as HTMLElement;
}

describe("the round + (C2-CALP8)", () => {
  it("offers New tour, New task and New service", async () => {
    mount("all");
    const plus = await headerPlus();
    fireEvent.pointerDown(plus, { button: 0, ctrlKey: false });
    fireEvent.click(plus);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["New tour", "New task", "New service"]);
  });

  it("New service opens the add-service form (the + menu is no longer a dead end)", async () => {
    mount("all");
    const plus = await headerPlus();
    fireEvent.pointerDown(plus, { button: 0, ctrlKey: false });
    fireEvent.click(plus);
    fireEvent.click(await screen.findByText("New service"));
    await waitFor(() => expect(document.querySelector('[role="dialog"], [data-attr*="service"]')).toBeTruthy());
  });
});

describe("empty week (C2-CALP6)", () => {
  it("says so in one line above the grid, and the header + stays the only create", async () => {
    mount("all");
    await waitFor(() => expect(screen.getByText("Nothing scheduled this week")).toBeTruthy());
    const strip = document.querySelector('[data-attr="calendar-empty-strip"]')!;
    // The strip never draws a second + (tests/unit/manager-calendar-views.test.tsx).
    expect(within(strip as HTMLElement).queryByRole("button", { name: "Add" })).toBeNull();
    expect(document.querySelector('[data-attr="calendar-time-grid"]')).toBeTruthy();
  });
});

describe("views", () => {
  it("Month shows the Monday-first grid with a hatched strip where tours can be booked", async () => {
    SLOTS[P1] = new Set(everythingKeys(NEXT_TUE, 26, 32));
    mount("all", { viewMode: "month", defaultViewMode: "month", anchorDate: new Date(`${NEXT_TUE}T12:00:00`) });
    await waitFor(() => expect(document.querySelector('[data-attr="calendar-month-view"]')).toBeTruthy());
    expect(document.querySelectorAll('[data-attr="calendar-month-open"]').length).toBeGreaterThan(0);
  });

  it("Agenda lists nothing but the one-line empty state when the week is empty", async () => {
    mount("all", { viewMode: "agenda", defaultViewMode: "agenda" });
    await waitFor(() => expect(screen.getByText("Nothing scheduled this week")).toBeTruthy());
  });

  it("Day is the grid plus a side panel with the day's open tour times as chips", async () => {
    SLOTS[P1] = new Set(everythingKeys(NEXT_TUE, 40, 44));
    mount("all", { viewMode: "day", defaultViewMode: "day", anchorDate: new Date(`${NEXT_TUE}T12:00:00`) });
    await waitFor(() => expect(document.querySelector('[data-attr="calendar-day-agenda"]')).toBeTruthy());
    expect(document.querySelector('[data-attr="calendar-day-open-summary"]')?.textContent).toBe("8 – 10 pm · 2 h");
    expect(document.querySelectorAll('[data-attr="calendar-day-slot"]')).toHaveLength(4);
  });
});
