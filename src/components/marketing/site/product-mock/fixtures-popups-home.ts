/**
 * Fixture data for the home demo's Properties and Calendar pop-ups and record pages
 * (`demo-popups-home.tsx`). Seattle Homes sample data only: no real person, no photo.
 * Counts a screen prints are derived from these rows, never typed beside them.
 */

import {
  AREA_BY_PROPERTY,
  SERVICE_ROWS,
  TOUR_ROWS,
  type CalendarFixtureItem,
  type PropertyFixtureRow,
  type ServiceFixtureRow,
  type TourFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";

/**
 * The real Properties list has Listed, Unlisted and Drafts tabs; the world's four houses are all listed,
 * so the demo draws one house the manager took off the market and one unfinished draft beside them.
 */
export const HOME_EXTRA_PROPERTIES: PropertyFixtureRow[] = [
  { id: "prop-cedar", title: "Cedar Cottage", street: "905 Cedar Ave", neighborhood: "Capitol Hill", rooms: 2, rentLabel: "$1,520/mo", stage: "unlisted" },
  { id: "prop-pine-draft", title: "", street: "88 Pine St", neighborhood: "Queen Anne", rooms: 3, rentLabel: "", stage: "draft" },
];

/** What a draft with no name shows (`managerPropertyRowTitle`). */
export function homePropertyTitle(row: Pick<PropertyFixtureRow, "title" | "stage">): string {
  return row.title.trim() || (row.stage === "draft" ? "Untitled draft" : "Untitled property");
}

/** The properties a Share listing link picks from: the listed ones, as the share modal lists them. */
export function shareablePropertyOptions(rows: Pick<PropertyFixtureRow, "id" | "title" | "street" | "stage" | "rooms">[]) {
  return rows
    .filter((row) => row.stage === "listed")
    .map((row) => ({ value: row.id, label: `${row.title} · ${row.rooms} ${row.rooms === 1 ? "room" : "rooms"}` }));
}

/** House facts for a property record's House details / Preview (fixture values; city and state are the demo's Seattle). */
export function homePropertyFacts(row: PropertyFixtureRow) {
  const rooms = Array.from({ length: row.rooms }, (_, index) => `Room ${index + 1}`);
  const rent = row.rentLabel.replace(/\/mo$/, "");
  return {
    street: row.street,
    city: "Seattle",
    state: "WA",
    zip: "98100",
    neighborhood: row.neighborhood,
    area: AREA_BY_PROPERTY[row.title] ?? `${row.neighborhood}, Seattle`,
    type: row.rooms === 1 ? "An apartment" : "A house",
    rentModel: row.rooms === 1 ? "The whole place" : "By the room",
    stays: "Long term",
    rooms,
    bathrooms: Math.max(1, Math.ceil(row.rooms / 2)),
    floors: row.rooms > 2 ? 2 : 1,
    rent,
    amenities: ["Washer and dryer", "Fenced yard", "Street parking"],
  };
}

/* ───────────────────────────── Calendar records ───────────────────────────── */

export type HomeTourRecord = {
  kind: "tour";
  guest: string;
  email: string;
  phone: string;
  property: string;
  room: string;
  format: string;
  status: string;
  when: string;
};

export type HomeTaskRecord = {
  kind: "task";
  title: string;
  property: string;
  assignee: string;
  priority: string;
  timing: string;
  when: string;
  status: string;
  linked: string;
};

export type HomeServiceRecord = {
  kind: "service";
  title: string;
  property: string;
  resident: string;
  vendor: string;
  status: string;
  when: string;
  detail: string;
};

export type HomeCalendarRecord = HomeTourRecord | HomeTaskRecord | HomeServiceRecord;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Sat, Sep 27 · 2:00 – 2:30 PM" for a calendar item. */
export function calendarWhen(item: Pick<CalendarFixtureItem, "dateStr" | "startMin" | "durationMin">): string {
  const [y, m, d] = item.dateStr.split("-").map(Number) as [number, number, number];
  const day = DAY_NAMES[new Date(y, m - 1, d, 12).getDay()]!;
  return `${day}, ${MONTH_NAMES[m - 1]} ${d} · ${clock(item.startMin)} – ${clock(item.startMin + item.durationMin)}`;
}

function tourRowFor(item: CalendarFixtureItem): TourFixtureRow | undefined {
  return TOUR_ROWS.find((row) => row.guest === item.title);
}

function serviceRowFor(item: CalendarFixtureItem): ServiceFixtureRow | undefined {
  return SERVICE_ROWS.find((row) => row.detail.includes(item.title) && row.property === item.place);
}

/** The record behind a calendar item: what the real tour / task / service page prints for it. */
export function calendarRecordFor(item: CalendarFixtureItem): HomeCalendarRecord {
  const when = calendarWhen(item);
  if (item.kind === "tour") {
    const row = tourRowFor(item);
    const [property, room] = (row?.place ?? item.place).split(" · ");
    return {
      kind: "tour",
      guest: item.title,
      email: row?.email ?? "guest@example.com",
      phone: row?.phone ?? "(206) 555-0100",
      property: property ?? item.place,
      room: room ?? "Any room",
      format: row?.format === "virtual" ? "Virtual" : "In person",
      status: item.requested ? "Requested" : "Confirmed",
      when,
    };
  }
  if (item.kind === "task") {
    return {
      kind: "task",
      title: item.title,
      property: item.place,
      assignee: item.assignee ?? "Manager",
      priority: "Medium",
      timing: "Scheduled",
      status: "Open",
      when,
      linked: "Lease · Jamie P.",
    };
  }
  const row = serviceRowFor(item);
  return {
    kind: "service",
    title: row?.title ?? item.title,
    property: item.place,
    resident: row?.resident ?? "Resident",
    vendor: item.assignee ?? item.title,
    status: row ? (row.state === "scheduled" ? "Scheduled" : row.state === "open" ? "Open" : row.state === "done" ? "Completed" : "Declined") : "Scheduled",
    when,
    detail: row?.detail ?? "",
  };
}

/* ───────────────────────────── Add pop-ups ───────────────────────────── */

export const TOUR_OPEN_TIMES = ["9 am", "9:30 am", "10 am", "11 am", "1 pm", "2 pm", "3:30 pm", "4 pm"];

export const DEMO_TOUR_ROOMS = ["Any room", "Room 1", "Room 2", "Room 3"];

export const TASK_ASSIGNEES = [
  { value: "me", label: "Manager (you)" },
  { value: "cascade", label: "Cascade Locksmiths" },
  { value: "pacific", label: "Pacific Plumbing" },
];

export const SERVICE_TYPES = [
  { value: "repair", label: "Repair" },
  { value: "cleaning", label: "Cleaning" },
  { value: "pest", label: "Pest control" },
  { value: "locks", label: "Locks and keys" },
];

/** The availability popup's starting values: weekdays 9 am to 5 pm for tours, every week. */
export const DEMO_AVAILABILITY_START = {
  kinds: ["tours"],
  weekdays: [0, 1, 2, 3, 4],
  startSlot: 18,
  endSlotExclusive: 34,
};
