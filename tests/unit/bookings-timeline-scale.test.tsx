// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookingBar } from "@/components/portal/bookings-timeline-bar";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { layoutRoom, narrowHouseBySearch, placeBars, windowRows, columnPx } from "@/components/portal/bookings-timeline-layout";
import { calendarOccupancyOnDay, calendarStatus, calendarStatusClass } from "@/lib/channel-calendar/bookings-calendar-view";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import type { OccupancyCapacities } from "@/lib/occupancy/snapshot";
import { dateKey } from "@/lib/room-availability-calendar";

const TODAY = new Date(2026, 9, 18); // Oct 18, 2026
const TODAY_KEY = dateKey(TODAY);
const CAPACITIES: OccupancyCapacities = { bedsTotal: () => 3, roomCapacity: () => 1 };
const resolveRooms = () => [1, 2, 3].map(n => ({ id: `room-${n}`, label: `Room ${n}`, rent: "" }));
const resolveHouse = (propertyId: string) => ({ name: `House ${propertyId.toUpperCase()}`, address: `${propertyId} Test St` });
const ids = (count: number) => Array.from({ length: count }, (_, index) => `h${index + 1}`);

function stay(overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry {
  return { source: "proplane", propertyId: "h1", propertyLabel: "House H1", roomId: "room-1", roomLabel: "Room 1", summary: "Jordan Smith", residentName: "Jordan Smith", start: "2026-10-12", end: "2026-10-30", bookingStatus: "confirmed", ...overrides };
}

let phone = false;
beforeEach(() => {
  phone = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine") || (phone && query.includes("max-width: 639px")),
    media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  }));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mount = (propertyCount: number, extra: Partial<React.ComponentProps<typeof BookingsPortfolioTimeline>> = {}) =>
  render(<BookingsPortfolioTimeline propertyIds={ids(propertyCount)} entries={[]} today={TODAY} resolveRooms={resolveRooms} resolveHouse={resolveHouse} capacities={CAPACITIES} preferenceKey="scale-test" {...extra} />);
const roomRows = () => document.querySelectorAll("[data-room-row]");
const houseButtons = () => [...document.querySelectorAll('[data-attr^="bookings-timeline-property-"] button[aria-expanded]')];

describe("houses collapse by default past three", () => {
  it("collapses more than 3 multi-room houses and keeps 3 or fewer open", () => {
    mount(4);
    expect(houseButtons()).toHaveLength(4);
    expect(roomRows()).toHaveLength(0);
    cleanup();
    mount(3);
    expect(roomRows()).toHaveLength(9);
  });

  it("Expand all / Collapse all is one icon action that flips, and a house toggles on its own", () => {
    mount(4);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(roomRows()).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(roomRows()).toHaveLength(0);
    fireEvent.click(houseButtons()[1]!);
    expect(roomRows()).toHaveLength(3);
    expect(houseButtons()[1]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("remembers the open set per page", () => {
    const first = mount(4);
    fireEvent.click(houseButtons()[0]!);
    first.unmount();
    mount(4);
    expect(roomRows()).toHaveLength(3);
    cleanup();
    mount(4, { preferenceKey: "another-page" });
    expect(roomRows()).toHaveLength(0);
  });

  it("only offers Expand all when there are two or more multi-room houses", () => {
    mount(1);
    expect(screen.queryByRole("button", { name: /^(Expand|Collapse) all$/ })).toBeNull();
  });

  it("prints beds on the focus day and the range average in plain labels, never a peak beside a percent", () => {
    mount(1, { entries: [stay({ start: TODAY_KEY, end: "2026-10-25" })] });
    const line = document.querySelector('[data-attr="bookings-property-occupied"]')!.textContent!;
    expect(line).toMatch(/^1\/3 tonight · \d+% avg$/);
    expect(document.querySelector('[data-attr="bookings-calendar-summary"]')!.textContent).toContain("1/3Tonight");
  });
});

describe("search filters houses, rooms and guests", () => {
  const entries = [
    stay({ propertyId: "h1", roomId: "room-1", residentName: "Maya Chen", summary: "Maya Chen" }),
    stay({ propertyId: "h1", roomId: "room-2", residentName: "Daniel Reyes", summary: "Daniel Reyes", propertyLabel: "House H1", roomLabel: "Room 2" }),
    stay({ propertyId: "h2", propertyLabel: "House H2", roomId: "room-1", residentName: "Priya Shah", summary: "Priya Shah" }),
    stay({ propertyId: "h3", propertyLabel: "House H3", roomId: "room-3", roomLabel: "Room 3", residentName: "Noor Alvarez", summary: "Noor Alvarez" }),
    stay({ propertyId: "h4", propertyLabel: "House H4", residentName: "Leo Park", summary: "Leo Park" }),
  ];
  const barNames = () => [...document.querySelectorAll('[data-attr="bookings-calendar-bar"]')].map(bar => bar.getAttribute("aria-label"));

  it("a house name shows that house with all its rooms (auto-expanded)", () => {
    mount(4, { entries, searchQuery: "House H2" });
    expect(houseButtons()).toHaveLength(1);
    expect(roomRows()).toHaveLength(3);
  });

  it("a room label shows those rooms in every house, and nothing else", () => {
    mount(4, { entries, searchQuery: "Room 3" });
    expect(roomRows()).toHaveLength(4);
  });

  it("a guest shows the room holding them and only the matching bar", () => {
    mount(4, { entries, searchQuery: "Maya" });
    expect(houseButtons()).toHaveLength(1);
    expect(roomRows()).toHaveLength(1);
    // The bar's label now carries both exact times (bookings-times-1018).
    expect(barNames()).toEqual(["Maya Chen, In-house, in Oct 12, 3:00 pm, out Oct 31, 11:00 am"]);
    // The KPI strip counts the visible scope.
    expect(document.querySelector('[data-attr="bookings-calendar-summary"]')!.textContent!.startsWith("1Staying")).toBe(true);
  });

  it("no match anywhere reads No matches", () => {
    mount(4, { entries, searchQuery: "zzzz" });
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(houseButtons()).toHaveLength(0);
  });

  it("narrowHouseBySearch: guest hits keep a hidden stay's nights busy", () => {
    const house = { propertyId: "h1", name: "House H1", address: "", rooms: resolveRooms(), entries: [entries[0]!, stay({ residentName: "Someone Else", summary: "Someone Else", start: "2026-10-20", end: "2026-10-22" })] };
    const narrowed = narrowHouseBySearch(house, "Maya")!;
    expect(narrowed.entriesByRoom!.get("room-1")).toHaveLength(1);
    const layout = layoutRoom({ room: house.rooms[0]!, all: house.entries, shown: narrowed.entriesByRoom!.get("room-1"), view: "month", days: Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`), anchor: "2026-10-01", propertyId: "h1", capacities: CAPACITIES, entryKey: entry => entry.summary });
    expect(layout.bars).toHaveLength(1);
    expect(layout.busy[20]).toBe(true);
  });
});

describe("rows render efficiently", () => {
  function withScroller(height: number) {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("data-attr") === "bookings-calendar-scroll" ? height : 0; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.getAttribute("data-attr") === "bookings-calendar-scroll" ? 1000 : 0; });
  }
  it("a 100 x 10 portfolio draws a bounded number of rows once the scroller is measured", () => {
    withScroller(800);
    mount(100);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const drawn = roomRows().length + houseButtons().length;
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(80);
    // The spacers keep the full height: 100 house rows (56) + 300 room rows (52).
    const spacer = [...document.querySelectorAll('[data-attr="bookings-calendar-scroll"] > div > div[aria-hidden]')].reduce((sum, el) => sum + parseFloat((el as HTMLElement).style.height), 0);
    expect(spacer + houseButtons().length * 56 + roomRows().length * 52).toBe(100 * (56 + 3 * 52));
  });

  it("scrolling moves the window", () => {
    withScroller(800);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    mount(100);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const scroller = document.querySelector('[data-attr="bookings-calendar-scroll"]') as HTMLElement;
    const before = [...document.querySelectorAll("[data-attr^='bookings-timeline-property-']")].map(el => el.getAttribute("data-attr"));
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 20000 });
    act(() => { fireEvent.scroll(scroller); });
    const after = [...document.querySelectorAll("[data-attr^='bookings-timeline-property-']")].map(el => el.getAttribute("data-attr"));
    expect(after).not.toEqual(before);
    expect(roomRows().length).toBeLessThan(80);
  });

  it("windows nothing when the scroller is unmeasured or the list is small", () => {
    mount(4);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(roomRows()).toHaveLength(12);
    expect(windowRows(Array.from({ length: 200 }, (_, i) => ({ top: i * 52, height: 52 })), 0, 0)).toEqual({ first: 0, last: 200 });
    expect(windowRows(Array.from({ length: 59 }, (_, i) => ({ top: i * 52, height: 52 })), 0, 800)).toEqual({ first: 0, last: 59 });
  });
});

describe("opaque sticky chrome", () => {
  it("every sticky surface is opaque (--pl-surface-raised), never the translucent bg-card", () => {
    mount(3, { entries: [stay()] });
    const sticky = [...document.querySelectorAll('[data-attr="bookings-calendar-scroll"] [class*="sticky"]')].filter(el => (el as HTMLElement).className.includes("sticky left-0") || (el as HTMLElement).className.includes("sticky top-0"));
    expect(sticky.length).toBeGreaterThan(5);
    for (const el of sticky) {
      expect(el.className, el.className).toContain("bg-[var(--pl-surface-raised)]");
      expect(el.className).not.toMatch(/(^|\s)bg-card(\s|$)/);
    }
    const corner = document.querySelector('[data-attr="bookings-calendar-scroll"] .sticky.left-0.z-40')!;
    expect(corner.textContent).toBe("3 houses");
  });

  it("bars live in the track, never in the label column", () => {
    mount(3, { entries: [stay()] });
    const label = document.querySelector("[data-room-row] > div")!;
    expect(label.querySelector('[data-attr="bookings-calendar-bar"]')).toBeNull();
  });
});

describe("bars: readable, and a narrow one names itself beside it", () => {
  it("a wide bar's name starts after the part scrolled under the label column, so it truncates instead of being cut at the front", async () => {
    mount(1, { entries: [stay()] });
    const bar = document.querySelector('[data-attr="bookings-calendar-bar"]') as HTMLElement;
    const visual = bar.querySelector("[data-bar-visual]") as HTMLElement;
    expect(visual.className).toContain("overflow-clip");
    const name = visual.firstElementChild as HTMLElement;
    expect(name.className).toContain("truncate");
    expect(name.style.marginLeft).toBe("0px");
    expect(name.textContent).toBe("Jordan Smith");
    const scroller = document.querySelector('[data-attr="bookings-calendar-scroll"]') as HTMLElement;
    const barLeft = parseFloat(bar.style.left);
    const barWidth = parseFloat(bar.style.width);
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, value: barLeft + 40 });
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    });
    const moved = document.querySelector('[data-attr="bookings-calendar-bar"] [data-bar-visual]')!.firstElementChild as HTMLElement;
    expect(moved.style.marginLeft).toBe("40px");
    expect(moved.style.maxWidth).toBe(`${barWidth - 40}px`);
  });

  it("a bar under 56px never draws its name: no outside label, no text inside, the full name stays in title + aria-label", () => {
    mount(1, { entries: [stay({ start: "2026-10-20", end: "2026-10-20", summary: "Short Stay", residentName: "Short Stay", source: "ical", channelLabel: "Houfy" })] });
    const bar = document.querySelector('[data-attr="bookings-calendar-bar"]') as HTMLElement;
    const visual = bar.querySelector("[data-bar-visual]")!;
    expect(visual.textContent).toBe("Short Stay"); // sr-only inside the bar only
    expect(visual.querySelector(".sr-only")).not.toBeNull();
    expect(bar.children).toHaveLength(1); // nothing beside the bar
    expect(bar.title).toBe("Short Stay");
    expect(bar.getAttribute("aria-label")).toContain("Short Stay");
    expect(bar.textContent).not.toContain("H · ");
    expect(parseFloat(bar.style.width)).toBe(parseFloat((visual as HTMLElement).style.width));
  });

  it("a narrow Airbnb bar shows its glyph centred inside, a bar under 20px shows nothing", () => {
    mount(1, { entries: [stay({ start: "2026-10-20", end: "2026-10-20", summary: "Airbnb guest", residentName: "Airbnb guest", source: "airbnb" })] });
    const visual = document.querySelector('[data-attr="bookings-calendar-bar"] [data-bar-visual]') as HTMLElement;
    expect(visual.className).toContain("justify-center");
    expect(visual.querySelector('[aria-label="Airbnb"]')).not.toBeNull();
    cleanup();
    // Under NARROW_GLYPH_PX the glyph itself would not fit: the bar is a plain block, the name stays in title/aria-label.
    render(<BookingBar entry={stay({ summary: "Airbnb guest", residentName: "Airbnb guest", source: "airbnb" })} today={TODAY_KEY} placement={{ left: 0, top: 0, width: 14, nameInset: 0, narrow: true }} />);
    const tiny = document.querySelector('[data-attr="bookings-calendar-bar"]') as HTMLElement;
    const tinyVisual = tiny.querySelector("[data-bar-visual]") as HTMLElement;
    expect(tinyVisual.querySelector('[aria-label="Airbnb"]')).toBeNull();
    expect(tiny.title).toBe("Airbnb guest");
  });

  it("placeBars marks a bar under 56px narrow and never produces an outside label", () => {
    const spec = (start: number, end: number, summary: string) => ({ entry: stay({ summary, residentName: summary }), key: summary, lane: 0, start, end, conflict: false });
    const placed = placeBars([spec(2, 3, "Alpha Person"), spec(4, 5, "Beta Person"), spec(10, 11, "Gamma Person"), spec(14, 20, "Wide Person")], 26, []);
    expect(placed.slice(0, 3).every(bar => bar.narrow)).toBe(true);
    expect(placed[3]!.narrow).toBe(false);
    expect(placed.every(bar => !("labelWidth" in bar))).toBe(true);
  });

  it("the date arrows hug the title (‹ title ›) and Today sits apart; the scroller fills its parent instead of a viewport formula", () => {
    mount(1);
    const title = document.querySelector('[data-attr="bookings-calendar-title"]') as HTMLElement;
    expect(title.className).not.toContain("flex-1");
    const prev = screen.getByRole("button", { name: "Previous month" });
    const nextButton = screen.getByRole("button", { name: "Next month" });
    expect(title.previousElementSibling).toBe(prev);
    expect(title.nextElementSibling).toBe(nextButton);
    expect(nextButton.nextElementSibling!.className).toContain("flex-1"); // the spacer before Today
    expect(nextButton.nextElementSibling!.nextElementSibling).toBe(document.querySelector('[data-attr="bookings-calendar-today"]'));
    const scroller = document.querySelector('[data-attr="bookings-calendar-scroll"]') as HTMLElement;
    expect(scroller.className).toContain("flex-1");
    expect(scroller.className).toContain("min-h-0");
    expect(scroller.className).not.toContain("dvh");
    // The short-viewport floor belongs on the hub's frame: inside the overflow-hidden frame a floor on the
    // scroller is clipped and the last room row is unreachable.
    expect(scroller.className).not.toContain("22rem");
    const hub = readFileSync("src/components/portal/pro-portfolio-bookings-calendar.tsx", "utf8");
    expect(hub).toMatch(/PORTAL_CALENDAR_FRAME}\s*flex min-h-\[22rem\] flex-1 flex-col/);
  });

  it("columnPx: Week fits a phone, Month scrolls, nothing measured falls back to the floor", () => {
    expect(columnPx("week", 7, 246, true) * 7).toBeLessThanOrEqual(246.001);
    expect(columnPx("month", 31, 246, true) * 31).toBeGreaterThan(246);
    expect(columnPx("week", 7, 0, true)).toBe(28);
    expect(columnPx("day", 1, 300, true)).toBe(300);
  });
});

describe("the phone's bar sheet", () => {
  it("opens a sheet instead of the popover, titled by the guest, with the same actions", async () => {
    phone = true;
    const onDelete = vi.fn();
    mount(1, { entries: [stay({ source: "block", blockId: "b1", residentName: undefined, summary: "Reserved", blockKind: "closed", reason: "Painting", start: TODAY_KEY, end: "2026-10-24", bookingStatus: undefined })], onDeleteBlock: onDelete, onUnblockBooking: () => {} });
    fireEvent.click(document.querySelector('[data-attr="bookings-calendar-bar"]')!);
    const sheet = await screen.findByText("Open booking");
    expect(sheet).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-bar-sheet"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-bar-delete"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bookings-bar-unblock"]')).toBeTruthy();
  });
});

describe("calendarOccupancyOnDay and status contrast", () => {
  it("counts beds filled on one day with the same filter as the summary: residents yes, pending holds no", () => {
    const capacities: OccupancyCapacities = { bedsTotal: () => 4, roomCapacity: () => 1 };
    const entries = [
      stay({ source: "hold", roomId: "room-1" }),
      stay({ source: "proplane", roomId: "room-2" }),
      stay({ source: "block", residentName: "Dee", bookingStatus: "hold", roomId: "room-3" }),
    ];
    expect(calendarOccupancyOnDay(entries, "2026-10-15", ["h1"], capacities)).toEqual({ occupied: 2, beds: 4 });
    expect(calendarOccupancyOnDay(entries, "2026-11-30", ["h1"], capacities)).toEqual({ occupied: 0, beds: 4 });
  });

  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const HEX: Record<string, string> = { "bg-slate-500": "#64748b", "bg-[#3d7d46]": "#3d7d46", "bg-[#9a4b1a]": "#9a4b1a", "bg-primary": "#2f5fd0", "bg-amber-100": "#fef3c7", "text-white": "#ffffff", "text-amber-900": "#78350f" };

  it("every status class clears WCAG AA (4.5:1) for its own text", () => {
    for (const status of ["Hold", "Confirmed", "In-house", "Checked out", "Cancelled", "Blocked", "Airbnb", "Booking.com", "Houfy"]) {
      const classes = calendarStatusClass(status).split(" ");
      const bg = classes.find(name => name.startsWith("bg-"))!;
      const text = classes.find(name => name.startsWith("text-"))!;
      expect(contrast(HEX[bg]!, HEX[text]!), `${status}: ${bg} on ${text}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(calendarStatusClass("Checked out")).toContain("bg-slate-500");
    expect(calendarStatus(stay({ end: "2026-10-01" }), "2026-10-18")).toBe("Checked out");
  });
});
