/**
 * Fixture data for the home demo's Payments (incoming), Services and Communication pop-ups and record pages
 * (`demo-popups-money.tsx`, `panels-manager-money.tsx`). Seattle Homes sample data only: no real person, no real
 * address, no photo. Every count a panel prints is derived from the rows below and in `fixtures.ts`.
 */

import {
  COMM_CONVERSATIONS,
  PAYMENT_ROWS,
  PROPERTY_ROWS,
  RESIDENT_ROWS,
  VENDOR_ROWS,
  type PaymentFixtureRow,
  type ServiceFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";

/* ───────────────────────────── shared ───────────────────────────── */

/** The demo's "today" (the fixtures are written around Thu Sep 25, 2025). */
const DEMO_TODAY = Date.UTC(2025, 8, 25);
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Due Oct 1" / "Paid Sep 1" -> that day in 2025 (UTC midnight), or null. */
function parseShortDay(text: string): number | null {
  const match = /([A-Z][a-z]{2}) (\d{1,2})/.exec(text);
  if (!match || MONTHS[match[1]!] === undefined) return null;
  return Date.UTC(2025, MONTHS[match[1]!]!, Number(match[2]));
}

export const residentRoom = (name: string): string | undefined => {
  const row = RESIDENT_ROWS.find((r) => r.name === name);
  return row ? row.place.split(" · ")[0] : undefined;
};

export const residentEmailOf = (name: string): string =>
  RESIDENT_ROWS.find((r) => r.name === name)?.email ?? `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

/* ───────────────────────────── Payments ───────────────────────────── */

export const PAY_SORT_OPTIONS = [
  { value: "dueSoon" as const, label: "Due soonest" },
  { value: "dueLatest" as const, label: "Due latest" },
  { value: "amountDesc" as const, label: "Amount (high to low)" },
  { value: "amountAsc" as const, label: "Amount (low to high)" },
  { value: "resident" as const, label: "Resident (A–Z)" },
];

/** The charge types the Add charge pop-up offers (`MANAGER_PAYMENT_PRESETS`) with the title each one suggests. */
export const PAYMENT_TYPE_TITLES: Record<string, string> = {
  rent: "October rent",
  application_fee: "Application fee",
  utilities: "Utilities",
  move_in_fee: "Move-in fee",
  prorated_rent: "Prorated rent",
  security_deposit: "Security deposit",
  late_fee: "Late payment fee",
  other: "",
};

/** Dollars in a "$1,650.00" label. */
export const moneyToNumber = (label: string): number => Number(label.replace(/[^0-9.-]/g, "")) || 0;

export const formatUsd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The due day as a sortable number (the day in "Due Sep 1" / "Paid Aug 1"). */
export const paymentDueMs = (row: Pick<PaymentFixtureRow, "due">): number => parseShortDay(row.due) ?? 0;

export type DemoPaymentDetail = {
  amount: string;
  status: string;
  dueLabel: string;
  /** "Days overdue" / "Days until due" tile (unpaid rows). */
  days: { label: string; value: string } | null;
  paidOn: string | null;
  paidVia: string | null;
  room: string | null;
  history: { at: string; label: string }[];
};

/** What a charge's record page prints, read off the row and the demo's "today". */
export function demoPaymentDetail(row: PaymentFixtureRow): DemoPaymentDetail {
  const day = parseShortDay(row.due);
  const diff = day === null ? null : Math.round((day - DEMO_TODAY) / 86400000);
  const dueLabel = row.due.replace(/^(Due|Paid)\s+/, "");
  const paid = row.bucket === "paid";
  const history: { at: string; label: string }[] = [{ at: "Created", label: "Aug 25, 9:00 AM" }];
  if (row.bucket === "overdue") history.push({ at: "Reminder sent", label: "Sep 5, 9:00 AM" });
  if (paid) history.push({ at: "Paid", label: `${dueLabel}, 9:12 AM · Bank transfer` });
  return {
    amount: row.amount,
    status: row.bucket === "paid" ? "Paid" : row.bucket === "overdue" ? "Overdue" : "Pending",
    dueLabel,
    days:
      paid || diff === null
        ? null
        : { label: diff < 0 ? "Days overdue" : "Days until due", value: diff === 0 ? "Today" : String(Math.abs(diff)) },
    paidOn: paid ? dueLabel : null,
    paidVia: paid ? "Bank transfer" : null,
    room: residentRoom(row.resident) ?? null,
    history,
  };
}

/** A rent charge for a lease is refundable once paid; the demo has no deposits. */
export const paymentIsRefundable = (row: PaymentFixtureRow): boolean => row.bucket === "paid";

/** Properties the Add charge pop-up lists, and the residents each holds (current residents only). */
export const DEMO_PAYMENT_PROPERTIES = PROPERTY_ROWS.map((p) => ({ id: p.id, label: p.title }));
export const demoResidentsForProperty = (propertyLabel: string) =>
  RESIDENT_ROWS.filter((r) => r.tab === "current" && r.place.endsWith(` · ${propertyLabel}`)).map((r) => ({
    id: r.id,
    name: r.name,
    room: r.place.split(" · ")[0]!,
  }));

/** Distinct (resident) options of the rows a Payments list draws, for the Filter popover. */
export const paymentResidentOptions = (rows: PaymentFixtureRow[]) =>
  [...new Set(rows.map((r) => r.resident))].sort().map((name) => ({ id: name, label: name }));
export const paymentPropertyOptions = (rows: PaymentFixtureRow[]) =>
  [...new Set(rows.map((r) => r.property))].sort().map((label) => ({ id: label, label }));

export { PAYMENT_ROWS };

/* ───────────────────────────── Services ───────────────────────────── */

export type DemoServiceStage = "open" | "assigned" | "scheduled" | "completed";

export type MoneyServiceRow = ServiceFixtureRow & {
  stage: DemoServiceStage;
  room?: string;
  vendor?: string;
  visit?: string;
  price?: string;
};

/** The four real stages (`SERVICE_STAGE_TABS`) hold every row; the demo's old Open / Scheduled / Done / Declined re-bucket here. */
const STAGE_BY_STATE: Record<ServiceFixtureRow["state"], DemoServiceStage> = {
  open: "open",
  scheduled: "scheduled",
  done: "completed",
  declined: "completed",
};

/** Rows the base fixtures do not have: a service whose vendor is hired but whose visit is not booked yet. */
export const ASSIGNED_SERVICE_ROWS: ServiceFixtureRow[] = [
  {
    id: "wo-willow-hallway-light",
    title: "Hallway light flickering",
    kind: "maintenance",
    resident: "Priya Nair",
    property: "Willow Court",
    detail: "Evergreen Electric · Assigned Sep 24",
    state: "open",
  },
];

const VENDOR_NAMES = VENDOR_ROWS.map((v) => v.name);

export function moneyServiceRow(row: ServiceFixtureRow): MoneyServiceRow {
  const vendor = VENDOR_NAMES.find((name) => row.detail.startsWith(name));
  const price = /\$[\d,]+(\.\d+)?(\/mo)?/.exec(row.detail)?.[0];
  const visit = /((Mon|Tue|Wed|Thu|Fri|Sat|Sun|Today)[^·]*\d\s?[AP]M(\s?–\s?\d+:\d+\s?[AP]M)?)/.exec(row.detail)?.[0]?.trim();
  // A hired vendor with no visit booked yet stands in Assigned.
  const assigned = row.state === "open" && row.kind === "maintenance" && Boolean(vendor) && /^.+· Assigned/.test(row.detail);
  return {
    ...row,
    stage: assigned ? "assigned" : STAGE_BY_STATE[row.state],
    room: residentRoom(row.resident),
    vendor,
    visit,
    price,
  };
}

/** Add-on declined in the base fixtures stands under Completed with its reason, like the real list. */
export const serviceIsDeclined = (row: ServiceFixtureRow): boolean => row.state === "declined";

/** "Assigned to" options of the Services Filter: Anyone, Unassigned, Assigned, then each hired name. */
export function serviceAssigneeOptions(rows: MoneyServiceRow[]) {
  const names = [...new Set(rows.map((r) => r.vendor).filter((v): v is string => Boolean(v)))].sort();
  return [
    { id: "", label: "Anyone" },
    { id: "unassigned", label: "Unassigned" },
    { id: "assigned", label: "Assigned" },
    ...names.map((name) => ({ id: `vendor:${name}`, label: name })),
  ];
}

export function serviceMatchesAssignee(row: MoneyServiceRow, assignee: string): boolean {
  if (!assignee) return true;
  if (assignee === "unassigned") return !row.vendor;
  if (assignee === "assigned") return Boolean(row.vendor);
  return `vendor:${row.vendor ?? ""}` === assignee;
}

/** What the row's "next step" button says on its record (`managerServiceNextStep`) and what the ⋯ offers. */
export function serviceNextStep(row: MoneyServiceRow): { id: string; label: string } | null {
  if (row.stage === "completed") return null;
  if (row.kind === "add-on") return row.stage === "open" ? { id: "approve", label: "Approve" } : { id: "complete", label: "Mark done" };
  if (row.stage === "open") return { id: "dispatch", label: "Dispatch vendor" };
  if (row.stage === "assigned") return { id: "schedule", label: "Schedule" };
  return { id: "approve-change-order", label: "Approve change order" };
}

/** The row ⋯ (`managerServiceRowMenuItems` / `managerServiceRequestRowMenuItems`). */
export function serviceMenuItems(row: MoneyServiceRow): { id: string; label: string; danger?: boolean }[] {
  const items: { id: string; label: string; danger?: boolean }[] = [];
  if (row.kind === "add-on") {
    if (row.stage === "open") {
      items.push({ id: "approve", label: "Approve" }, { id: "decline", label: "Decline request" });
    }
    items.push({ id: "edit", label: "Edit" }, { id: "message", label: "Message" });
    if (row.stage !== "completed") items.push({ id: "delete", label: "Delete", danger: true });
    return items;
  }
  if (row.stage !== "completed") {
    if (row.stage === "open" && !row.vendor) {
      items.push({ id: "request-bids", label: "Request bids" }, { id: "assign", label: "Assign" });
    } else if (row.stage === "open") {
      items.push({ id: "approve-bid", label: "Approve bid" }, { id: "assign", label: "Reassign" });
    } else if (row.stage === "assigned") {
      items.push({ id: "schedule", label: "Schedule" }, { id: "assign", label: "Reassign" });
    } else {
      items.push({ id: "schedule", label: "Reschedule" }, { id: "complete", label: "Complete" });
    }
  }
  items.push({ id: "message", label: "Message" });
  if (row.stage !== "completed") items.push({ id: "delete", label: "Delete", danger: true });
  return items;
}

/** The Add service pop-up: the properties, rooms and residents it lists. */
export const DEMO_SERVICE_PROPERTIES = PROPERTY_ROWS.map((p) => ({ id: p.id, label: p.title }));
export const demoServiceResidents = (propertyLabel: string) =>
  RESIDENT_ROWS.filter((r) => r.tab === "current" && r.place.endsWith(` · ${propertyLabel}`)).map((r) => ({
    email: r.email,
    name: r.name,
    room: r.place.split(" · ")[0]!,
  }));
export const demoServiceRooms = (propertyLabel: string) =>
  [...new Set(RESIDENT_ROWS.filter((r) => r.place.endsWith(` · ${propertyLabel}`)).map((r) => r.place.split(" · ")[0]!))].sort();

/** Team members the "Add task" assignee picker offers. */
export const DEMO_TEAM_MEMBERS = [{ userId: "team-seattle-homes", name: "Seattle Homes team", email: "team@seattlehomes.example" }];
export const DEMO_TASK_VENDORS = VENDOR_ROWS.filter((v) => v.rank !== "Inactive").map((v) => ({ id: v.id, name: v.name, trade: v.trade, active: true }));

/* ───────────────────────────── Communication ───────────────────────────── */

export type DemoCommContact = {
  role: string;
  /** The Role filter's bucket: prospects and applicants are "Residents & applicants". */
  filterRole: "resident" | "vendor";
  /** The record the conversation is about (the "About" filter). */
  about: "tour" | "service" | "application";
  house?: string;
  room?: string;
  phone?: string;
  email?: string;
  /** A resident contact opens their record from the thread header. */
  resident?: boolean;
};

/** Who each fixture conversation is with, for the thread header's `role · house, room · phone · email` line. */
export const COMM_CONTACTS: Record<string, DemoCommContact> = {
  "comm-jamie": { role: "Prospect", filterRole: "resident", about: "tour", house: "Fremont Studio", phone: "(206) 555-0198", email: "jamie.p@example.com" },
  "comm-liam": { role: "Resident", filterRole: "resident", about: "service", house: "Alder House", room: "Room 1", phone: "(206) 555-0131", email: "liam.foster@example.com", resident: true },
  "comm-pacific": { role: "Vendor", filterRole: "vendor", about: "service", phone: "(206) 555-0142", email: "office@pacificplumbing.example" },
  "comm-ethan": { role: "Applicant", filterRole: "resident", about: "application", house: "Fremont Studio", phone: "(206) 555-0163", email: "ethan.wright@example.com" },
};

export function commSubtitle(id: string): string {
  const c = COMM_CONTACTS[id];
  if (!c) return "";
  const place = [c.house, c.room].filter(Boolean).join(", ");
  return [c.role, place, c.phone, c.email].filter(Boolean).join(" · ");
}

/** Recipients the New message pop-up lists (the contacts of the fixture conversations). */
export const COMM_RECIPIENTS = COMM_CONVERSATIONS.map((c) => ({ key: c.id, label: c.name }));

export { COMM_CONVERSATIONS };
