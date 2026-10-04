// @vitest-environment jsdom
/**
 * The shared Calendar's grid: who is doing what. One stable colour per person, everyone's hours
 * drawn (pale, with initials), booked items solid in their person's colour, a people row that only
 * filters the view, a click on a booked item opening its record, your own block opening "Your
 * availability" while someone else's does nothing, and "N open" counting every available person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import type { CoManagerCalendarPeerDto } from "@/lib/co-manager-calendar";
import {
  managerPropertyAvailabilityStorageKey,
  startOfWeekMonday,
  toLocalDateStr,
} from "@/lib/demo-admin-scheduling";
import { PERSON_COLORS } from "@/lib/calendar-people";
import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

const ME = "mgr-1";
const MAYA = "peer-b";
const P1 = managerPropertyAvailabilityStorageKey(ME, "p1");

let SLOTS: Record<string, Set<string>> = {};
let MEETINGS: DemoMeeting[] = [];
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
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: () => undefined,
}));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({ buildScheduledTourMeetings: () => MEETINGS }));
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

// Next week, so every slot is in the future and bookable whenever this runs.
const monday = (() => {
  const d = startOfWeekMonday(new Date());
  d.setDate(d.getDate() + 7);
  return d;
})();
const dayStr = (offset: number) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + offset);
  return toLocalDateStr(d);
};
const TUE = dayStr(1);

function meeting(over: Partial<DemoMeeting> & { slot: number; id: string }): DemoMeeting {
  const start = new Date(`${TUE}T00:00:00`);
  start.setMinutes(over.slot * 30);
  const end = new Date(start.getTime() + 30 * 60_000);
  return {
    source: "planned",
    sourceId: over.id,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: TUE,
    startSlot: over.slot,
    span: 1,
    durationMinutes: 30,
    title: "Item",
    color: "",
    ...over,
  } as DemoMeeting;
}

const peers: CoManagerCalendarPeerDto[] = [
  { userId: ME, label: "You", isSelf: true, slots: [] },
  {
    userId: MAYA,
    label: "Maya Chen",
    isSelf: false,
    // Maya offers tours 10:00-11:30; services 3:00-3:30 pm.
    slots: [`${TUE}:20`, `${TUE}:21`, `${TUE}:22`],
    kindSlots: { services: [`${TUE}:30`], tasks: [] },
  },
];

beforeEach(() => {
  // I offer tours 9:00-11:00.
  SLOTS = { [P1]: new Set([18, 19, 20, 21].map((slot) => `${TUE}:${slot}`)) };
  MEETINGS = [
    meeting({ id: "t1", slot: 28, kind: "task", sourceTaskId: "k1", title: "Room check", personUserId: MAYA }),
    // Maya is hosting a tour at 11:00, her last offered half hour.
    meeting({ id: "tour1", slot: 22, kind: "tour", title: "Tour · Guest", personUserId: MAYA }),
  ];
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

function mount(extra: Partial<React.ComponentProps<typeof PortalCalendarPanels>> = {}) {
  mockDesktop();
  const onOpenRecord = vi.fn();
  const utils = render(
    <PortalCalendarPanels
      storageKey={null}
      availabilityKeysByKind={{ tours: [P1] }}
      editKind="tours"
      compactAvailability
      bareSurface
      studioGrid
      calendarTab="all"
      defaultViewMode="week"
      viewMode="week"
      hideViewModeControl
      scheduleTourPropertyOptions={[{ id: "p1", label: "Alder House" }]}
      defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
      anchorDate={monday}
      coManagerPeers={peers}
      recordHrefFor={(m) =>
        m.kind === "task" ? "/portal/tasks/open/k1" : m.kind === "tour" ? "/portal/tours/upcoming/tour1" : null
      }
      onOpenRecord={onOpenRecord}
      {...extra}
    />,
  );
  return { onOpenRecord, ...utils };
}

const blocks = (own: "true" | "false") =>
  [...document.querySelectorAll(`[data-attr="calendar-availability-block"][data-own="${own}"]`)] as HTMLElement[];
const eventBlock = (title: string) =>
  [...document.querySelectorAll('[data-attr="calendar-event-block"]')].find((el) =>
    el.textContent?.includes(title),
  ) as HTMLElement | undefined;

// People sort by user id: "mgr-1" first, then "peer-b".
const MY_COLOR = PERSON_COLORS[0];
const MAYA_COLOR = PERSON_COLORS[1];

describe("who's doing what", () => {
  it("draws booked items solid in their person's colour with initials, and a vendor-less item stays plain", async () => {
    mount();
    await waitFor(() => expect(eventBlock("Room check")).toBeTruthy());
    const task = eventBlock("Room check")!;
    expect(task.getAttribute("data-person")).toBe(MAYA);
    expect(task.style.getPropertyValue("--pc")).toBe(MAYA_COLOR);
    expect(within(task).getByText("MC")).toBeTruthy();
    const tour = eventBlock("Tour · Guest")!;
    expect(tour.getAttribute("data-person")).toBe(MAYA);
  });

  it("draws everyone's hours pale with initials, kind and time; peers get blocks of each kind", async () => {
    mount();
    await waitFor(() => expect(blocks("false").length).toBe(2));
    const peerBlocks = blocks("false");
    expect(peerBlocks.every((b) => b.getAttribute("data-person") === MAYA)).toBe(true);
    const text = peerBlocks.map((b) => b.textContent ?? "").join("|");
    expect(text).toContain("Tours");
    expect(text).toContain("Services");
    expect(text).toContain("MC");
    // jsdom reports the colour as rgb(); the 12% tint and 45% border are the contract.
    expect(peerBlocks[0]!.style.background).toContain("12%");
    expect(peerBlocks[0]!.style.borderColor).toContain("45%");
    const mine = blocks("true");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.style.background).toContain("12%");
    expect(mine[0]!.style.background).toMatch(/#2a78d6|rgb\(42, 120, 214\)/);
    expect(MY_COLOR).toBe("#2a78d6");
    expect(mine[0]!.textContent).toContain("Tours");
  });

  it("lays overlapping blocks side by side instead of stacking them", async () => {
    mount();
    await waitFor(() => expect(blocks("false").length).toBe(2));
    // My 9-11 and Maya's 10-11:30 tours overlap, so each takes half the column.
    const mine = blocks("true")[0]!;
    const maya = blocks("false").find((b) => b.textContent?.includes("Tours"))!;
    expect(mine.style.width).toContain("50%");
    expect(maya.style.width).toContain("50%");
    expect(mine.style.left).not.toBe(maya.style.left);
  });

  it("the people row names everyone, marks you, and hiding someone never repaints the others", async () => {
    mount();
    const row = await screen.findByRole("group", { name: "People on this calendar" });
    expect(within(row).getByText("Maya Chen")).toBeTruthy();
    expect(within(row).getByText("You")).toBeTruthy();
    const before = blocks("true")[0]!.style.background;

    fireEvent.click(within(row).getByRole("button", { name: /Maya Chen/ }));
    await waitFor(() => expect(blocks("false")).toHaveLength(0));
    expect(eventBlock("Room check")).toBeUndefined();
    expect(eventBlock("Tour · Guest")).toBeUndefined();
    expect(blocks("true")[0]!.style.background).toBe(before);

    fireEvent.click(within(row).getByRole("button", { name: /Maya Chen/ }));
    await waitFor(() => expect(blocks("false")).toHaveLength(2));
    expect(eventBlock("Room check")!.style.getPropertyValue("--pc")).toBe(MAYA_COLOR);
  });

  it("hides the people row when you are the only person on the house", () => {
    mount({ coManagerPeers: [peers[0]!] });
    expect(screen.queryByRole("group", { name: "People on this calendar" })).toBeNull();
  });
});

describe("click to open", () => {
  it("a booked task or tour goes straight to its record, no quick-look dialog", async () => {
    const { onOpenRecord } = mount();
    await waitFor(() => expect(eventBlock("Room check")).toBeTruthy());
    fireEvent.click(eventBlock("Room check")!);
    expect(onOpenRecord).toHaveBeenLastCalledWith("/portal/tasks/open/k1");
    fireEvent.click(eventBlock("Tour · Guest")!);
    expect(onOpenRecord).toHaveBeenLastCalledWith("/portal/tours/upcoming/tour1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an item with no record behind it still opens the quick-look dialog", async () => {
    const { onOpenRecord } = mount({ recordHrefFor: () => null });
    await waitFor(() => expect(eventBlock("Room check")).toBeTruthy());
    fireEvent.click(eventBlock("Room check")!);
    expect(onOpenRecord).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("clicking your own availability opens Your availability; someone else's does nothing", async () => {
    const { onOpenRecord } = mount();
    await waitFor(() => expect(blocks("false").length).toBe(2));
    for (const block of blocks("false")) fireEvent.click(block);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenRecord).not.toHaveBeenCalled();

    fireEvent.click(blocks("true")[0]!);
    expect(await screen.findByRole("dialog", { name: "Your availability" })).toBeTruthy();
  });

  it("only your own blocks carry an x to remove", async () => {
    mount();
    await waitFor(() => expect(blocks("false").length).toBe(2));
    for (const block of blocks("false")) {
      expect(block.querySelector('[data-attr="calendar-availability-remove"]')).toBeNull();
    }
    const remove = blocks("true")[0]!.querySelector('[data-attr="calendar-availability-remove"]') as HTMLElement;
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    // Only my own tours record is written; Maya's is never touched from here.
    expect(writes.map((w) => w.key)).toEqual([P1]);
    expect(writes[0]!.slots).toEqual([]);
  });
});

describe("N open counts everyone who is available", () => {
  it("a slot stays open while anyone offers it and is free; Maya's booked 11:00 closes it", async () => {
    mockDesktop();
    render(
      <PortalCalendarPanels
        storageKey={null}
        availabilityKeysByKind={{ tours: [P1] }}
        editKind="tours"
        compactAvailability
        bareSurface
        studioGrid
        calendarTab="all"
        viewMode="day"
        defaultViewMode="day"
        hideViewModeControl
        scheduleTourPropertyOptions={[{ id: "p1", label: "Alder House" }]}
        defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
        anchorDate={new Date(`${TUE}T12:00:00`)}
        coManagerPeers={peers}
      />,
    );
    const chips = await waitFor(() => {
      const found = [...document.querySelectorAll('[data-attr="calendar-day-slot"]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // Mine 9:00-11:00 plus Maya's 10:00-10:30 (her 11:00 is booked): 9, 9:30, 10, 10:30.
    expect(chips.map((chip) => chip.textContent)).toEqual(["9 am", "9:30 am", "10 am", "10:30 am"]);
  });
});
