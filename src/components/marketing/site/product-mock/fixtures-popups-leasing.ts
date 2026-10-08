/**
 * Fixture data for the home demo's Tours, Applications and Leases pop-ups and record pages
 * (`demo-popups-leasing.tsx`). Seattle Homes sample data only: no real person, no real address,
 * no photo. Every count a pop-up prints is derived from these rows, never typed beside them.
 */

import { PROPERTY_ROWS, type ApplicationFixtureRow, type LeaseFixtureRow, type TourFixtureRow } from "@/components/marketing/site/product-mock/fixtures";

/* ───────────────────────────── properties ───────────────────────────── */

export type LeasingProperty = { id: string; label: string; street: string; rooms: string[]; rentLabel: string };

/** The rooms each house lets a visitor or applicant pick ("Any room" first). */
const ROOMS_BY_PROPERTY: Record<string, string[]> = {
  "prop-alder": ["Room 1", "Room 2", "Room 3"],
  "prop-maple": ["Unit A", "Unit B"],
  "prop-fremont": [],
  "prop-willow": ["Room 1", "Room 2", "Room 3"],
};

export const LEASING_PROPERTIES: LeasingProperty[] = PROPERTY_ROWS.map((p) => ({
  id: p.id,
  label: p.title,
  street: p.street,
  rooms: ROOMS_BY_PROPERTY[p.id] ?? [],
  rentLabel: p.rentLabel,
}));

export const propertyByTitle = (title: string): LeasingProperty | undefined => LEASING_PROPERTIES.find((p) => p.label === title);

/** "Alder House · Room 2" -> "Alder House". */
export const placeProperty = (place: string): string => place.split(" · ")[0] ?? place;
/** "Alder House · Room 2" -> "Room 2" ("" for a whole-house place). */
export const placeRoom = (place: string): string => place.split(" · ")[1] ?? "";

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** The public link a share pop-up copies. */
export function demoShareLink(kind: "tour" | "apply", propertyTitles: string[]): string {
  if (propertyTitles.length === 0) return "";
  if (propertyTitles.length > 1) return `proplane.ai/${kind === "tour" ? "tour" : "apply"}/seattle-homes`;
  return `proplane.ai/${kind === "tour" ? "tour" : "apply"}/${slug(propertyTitles[0]!)}`;
}

/* ───────────────────────────── tours ───────────────────────────── */

export const tourStatusLabel = (bucket: TourFixtureRow["bucket"]): string =>
  bucket === "pending" ? "Pending" : bucket === "upcoming" ? "Confirmed" : "Completed";

/** What the manager wrote on a tour, where there is something to say. */
export const TOUR_NOTES: Record<string, string> = {
  "tour-fremont-jamie": "Street parking on Fremont Ave N. Text on arrival.",
  "tour-alder-noah": "Will bring a roommate.",
  "tour-maple-priya": "Video call link goes out the morning of.",
};

/** What a tour action's notification preview says (pro-tours.tsx `TOUR_NOTIFY_PREVIEW_COPY`), with the toast the demo shows when it is sent. */
export type TourNotifyAction = "confirm" | "decline" | "cancel" | "reschedule" | "message" | "delete";

export const TOUR_NOTIFY_COPY: Record<TourNotifyAction, { title: string; skip?: string; confirm: string; done: string }> = {
  confirm: { title: "Confirm tour", skip: "Don't message guest", confirm: "Confirm tour & send notification", done: "Tour confirmed (sample)" },
  decline: { title: "Decline tour", skip: "Don't message guest", confirm: "Decline & send notification", done: "Tour declined (sample)" },
  cancel: { title: "Cancel tour", skip: "Don't message guest", confirm: "Cancel tour & send notification", done: "Tour canceled (sample)" },
  reschedule: { title: "Reschedule tour", skip: "Don't message guest", confirm: "Send & ask guest to confirm", done: "Reschedule sent (sample)" },
  message: { title: "Message guest", confirm: "Send message", done: "Message sent (sample)" },
  delete: { title: "Delete tour", skip: "Don't message guest", confirm: "Delete tour & send notification", done: "Tour deleted (sample)" },
};

/** The message each action drafts for the guest. */
export function tourNotifyMessage(action: TourNotifyAction, row: Pick<TourFixtureRow, "guest" | "place" | "when">): { subject: string; body: string } {
  const first = row.guest.split(/\s+/)[0] ?? row.guest;
  const hi = `Hi ${first},`;
  switch (action) {
    case "confirm":
      return { subject: "Your tour is confirmed", body: `${hi}\n\nYour tour of ${row.place} is confirmed for ${row.when}. Reply here if you need to change it.` };
    case "decline":
      return { subject: "About your tour request", body: `${hi}\n\nThank you for your interest in ${row.place}. That time is not available, so we cannot confirm this tour.` };
    case "cancel":
      return { subject: "Your tour was canceled", body: `${hi}\n\nYour tour of ${row.place} on ${row.when} has been canceled. Reply here to set up another time.` };
    case "reschedule":
      return { subject: "A new time for your tour", body: `${hi}\n\nWe would like to move your tour of ${row.place}. Please confirm the new time or reply with one that works for you.` };
    case "delete":
      return { subject: "Your tour was removed", body: `${hi}\n\nYour tour of ${row.place} has been removed. Reply here if you would still like to see the home.` };
    default:
      return { subject: "", body: "" };
  }
}

/** The open half-hour windows a visitor can book on a day (Pacific time). */
export const TOUR_OPEN_SLOTS = ["9:00 AM", "9:30 AM", "10:00 AM", "11:00 AM", "1:00 PM", "2:00 PM", "2:30 PM", "4:00 PM"];

/** The demo week the availability grid shows. Hours are the open tour windows per day (24h, start inclusive, end exclusive). */
export const TOUR_AVAILABILITY_DAYS: { id: string; label: string; windows: [number, number][] }[] = [
  { id: "mon", label: "Mon 22", windows: [[9, 12], [13, 17]] },
  { id: "tue", label: "Tue 23", windows: [[9, 12], [13, 17]] },
  { id: "wed", label: "Wed 24", windows: [[10, 12], [13, 16]] },
  { id: "thu", label: "Thu 25", windows: [[9, 12], [13, 18]] },
  { id: "fri", label: "Fri 26", windows: [[9, 12]] },
  { id: "sat", label: "Sat 27", windows: [[11, 16]] },
  { id: "sun", label: "Sun 28", windows: [] },
];
export const TOUR_AVAILABILITY_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
export const hourLabel = (hour: number): string => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;

/* ───────────────────────────── applications ───────────────────────────── */

/** A tab of the real Applications page: Pending · Approved · Declined (route ids pending / approved / rejected). */
export type DemoApplicationTab = "pending" | "approved" | "rejected";

/** The real list has no Incomplete tab: an unfinished application sits in Pending. */
export const applicationTabOf = (row: Pick<ApplicationFixtureRow, "bucket">): DemoApplicationTab => (row.bucket === "incomplete" ? "pending" : row.bucket);

export const isIncompleteApplication = (row: Pick<ApplicationFixtureRow, "bucket">): boolean => row.bucket === "incomplete";

export type DemoApplicationDetail = {
  phone: string;
  preferred: string;
  moveIn: string;
  term: string;
  occupants: string;
  pets: string;
  dob: string;
  employer: string;
  jobTitle: string;
  income: number;
  employedSince: string;
  currentAddress: string;
  currentLandlord: string;
  currentSince: string;
  previousAddress: string;
  reference: string;
  emergency: string;
  disclosures: string;
  asks: { label: string; value: string }[];
};

const hash = (text: string) => [...text].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);

const EMPLOYERS: [string, string, number][] = [
  ["Northwind Coffee", "Shift lead", 3900],
  ["Harbor Dental Group", "Dental assistant", 4300],
  ["Cedar Logistics", "Dispatcher", 4600],
  ["University of Washington", "Research technician", 5100],
  ["Pike Street Bakery", "Baker", 3500],
];

/** What an application holds, derived from the row so a list and its record never disagree. */
export function demoApplicationDetail(row: ApplicationFixtureRow): DemoApplicationDetail {
  const h = hash(row.id);
  const [employer, jobTitle, income] = EMPLOYERS[h % EMPLOYERS.length]!;
  const shared = Boolean(row.sharedFact);
  return {
    phone: `(206) 555-0${String(100 + (h % 90)).padStart(3, "0")}`,
    preferred: h % 2 === 0 ? "Email" : "Text",
    moveIn: row.bucket === "approved" ? "Oct 1, 2025" : "Oct 15, 2025",
    term: "12 months",
    occupants: shared ? "2 people" : "1 person",
    pets: h % 3 === 0 ? "1 cat" : "None",
    dob: `${1 + (h % 12)}/${1 + (h % 27)}/${1992 + (h % 9)}`,
    employer,
    jobTitle,
    income,
    employedSince: `${2019 + (h % 5)}`,
    currentAddress: `${100 + (h % 800)} Pine St, Seattle, WA`,
    currentLandlord: "Harper Property Group",
    currentSince: `${2022 + (h % 3)}`,
    previousAddress: `${40 + (h % 300)} Union Ave, Tacoma, WA`,
    reference: "Dana Whitfield (former landlord)",
    emergency: "Robin Whitfield (parent)",
    disclosures: "No evictions, bankruptcies or convictions",
    asks: [
      { label: "Do you smoke?", value: "No" },
      { label: "Anything we should know about your move-in date?", value: "Flexible by a week" },
    ],
  };
}

export type DemoScreening = { status: "Passed" | "Flagged" | "Not run"; rows: { label: string; value: string; tone?: "ok" | "bad" }[] };

export function demoScreening(row: ApplicationFixtureRow): DemoScreening {
  if (row.screening === "passed") {
    return {
      status: "Passed",
      rows: [
        { label: "Identity", value: "Verified", tone: "ok" },
        { label: "Credit", value: "Within the property's standard", tone: "ok" },
        { label: "Evictions", value: "None found", tone: "ok" },
        { label: "Report", value: "Ordered Sep 22, 2025" },
      ],
    };
  }
  if (row.screening === "flagged") {
    return {
      status: "Flagged",
      rows: [
        { label: "Identity", value: "Verified", tone: "ok" },
        { label: "Credit", value: "Below the property's standard", tone: "bad" },
        { label: "Evictions", value: "1 record found", tone: "bad" },
        { label: "Report", value: "Ordered Sep 23, 2025" },
      ],
    };
  }
  return { status: "Not run", rows: [{ label: "Report", value: "No background check yet" }] };
}

/* ───────────────────────────── leases ───────────────────────────── */

/** The real lease tab ids: the demo's four buckets under the page's own words. */
export const LEASE_TAB_LABELS: { id: LeaseFixtureRow["bucket"]; label: string }[] = [
  { id: "manager", label: "Draft" },
  { id: "resident", label: "Resident signature" },
  { id: "signed", label: "Manager signature" },
  { id: "completed", label: "Signed" },
];

/** The demo's "today", for the Updated filter. */
const TODAY = { month: 8, day: 26 }; // Sep 26
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Days between a row's "Sep 24" stamp and the demo's today. */
export function daysSinceStamp(stamp: string): number {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2})/.exec(stamp.trim());
  if (!match) return 0;
  const month = MONTHS[match[1]!];
  if (month === undefined) return 0;
  const then = Date.UTC(2025, month, Number(match[2]));
  const now = Date.UTC(2025, TODAY.month, TODAY.day);
  return Math.max(0, Math.round((now - then) / 86_400_000));
}

export type DemoLeaseDetail = {
  rent: number;
  deposit: number;
  start: string;
  end: string;
  form: string;
  residentSigned: string;
  managerSigned: string;
  sent: string;
};

const rentOf = (place: string): number => {
  const property = propertyByTitle(placeProperty(place));
  const parsed = Number((property?.rentLabel ?? "$1,400/mo").replace(/[^0-9]/g, ""));
  return parsed || 1400;
};

export function demoLeaseDetail(row: LeaseFixtureRow): DemoLeaseDetail {
  const rent = rentOf(row.place);
  const signedLike = row.bucket === "signed" || row.bucket === "completed";
  return {
    rent,
    deposit: rent,
    start: "Oct 1, 2025",
    end: "Sep 30, 2026",
    form: "Washington residential lease",
    residentSigned: signedLike ? row.updated : "",
    managerSigned: row.bucket === "completed" ? row.updated : "",
    sent: row.bucket === "manager" ? "" : row.updated,
  };
}

export type DemoSigner = { role: "Resident" | "You"; name: string; state: "signed" | "sent" | "waiting"; at: string; action?: "remind" | "sign" };

/** Who signed, as the record's strip prints it. */
export function demoLeaseSigners(row: LeaseFixtureRow, managerName: string): DemoSigner[] {
  const detail = demoLeaseDetail(row);
  const resident: DemoSigner =
    row.bucket === "manager"
      ? { role: "Resident", name: row.resident, state: "waiting", at: "" }
      : row.bucket === "resident"
        ? { role: "Resident", name: row.resident, state: "sent", at: detail.sent, action: "remind" }
        : { role: "Resident", name: row.resident, state: "signed", at: detail.residentSigned };
  const manager: DemoSigner =
    row.bucket === "completed"
      ? { role: "You", name: managerName, state: "signed", at: detail.managerSigned }
      : row.bucket === "signed"
        ? { role: "You", name: managerName, state: "waiting", at: "", action: "sign" }
        : { role: "You", name: managerName, state: "waiting", at: "" };
  return [resident, manager];
}

/** An approved applicant the manager has not sent a lease to yet (the Send lease pop-up's Resident list). */
export type DemoLeaseCandidate = { id: string; name: string; email: string; place: string; rent: number; shared?: { name: string; bed: string }[] };

export const DEMO_LEASE_CANDIDATES: DemoLeaseCandidate[] = [
  { id: "cand-mason", name: "Mason Clark", email: "mason.clark@example.com", place: "Alder House · Room 3", rent: 1650 },
  { id: "cand-olivia", name: "Olivia Brooks", email: "olivia.brooks@example.com", place: "Maple Duplex · Unit B", rent: 1850 },
  {
    id: "cand-ethan",
    name: "Ethan Wright",
    email: "ethan.wright@example.com",
    place: "Fremont Studio",
    rent: 1100,
    shared: [
      { name: "Ethan Wright", bed: "Bed 1" },
      { name: "Priya Shah", bed: "Bed 2" },
    ],
  },
];

export const DEMO_LEASE_FORMS = [
  { value: "wa-residential", label: "Washington residential lease" },
  { value: "wa-room-rental", label: "Room rental agreement" },
  { value: "month-to-month", label: "Month-to-month agreement" },
];

/** The payment schedule a lease creates, derived from the terms so it recomputes as they change. */
export function demoLeaseSchedule(rent: number, deposit: number): { key: string; label: string; amount: number }[] {
  return [
    { key: "deposit", label: "Security deposit · due at signing", amount: deposit },
    { key: "first", label: "First month's rent · due at signing", amount: rent },
    { key: "monthly", label: "Monthly rent · Nov 1, 2025 to Sep 1, 2026", amount: rent },
  ];
}

export const DEMO_LEASE_FEE = 45;

/* ───────────────────────────── conversations ───────────────────────────── */

export type DemoThreadMessage = { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" };

/** A short thread with a record's contact, for the Communication section. */
export function demoThread(kind: "tour" | "application" | "lease", name: string, place: string, managerName: string): DemoThreadMessage[] {
  const first = name.split(/\s+/)[0] ?? name;
  if (kind === "tour") {
    return [
      { id: "m1", author: name, body: `Hi, I'd like to see ${place}. Is this weekend open?`, at: "Sep 24, 9:12 AM", direction: "inbound" },
      { id: "m2", author: managerName, body: `Hi ${first}, yes. I have a slot open and I'll confirm it here.`, at: "Sep 24, 10:05 AM", direction: "outbound" },
    ];
  }
  if (kind === "application") {
    return [
      { id: "m1", author: managerName, body: `Hi ${first}, here is the link to apply for ${place}.`, at: "Sep 22, 11:30 AM", direction: "outbound" },
      { id: "m2", author: name, body: "Thanks, just submitted it. Let me know if you need anything else.", at: "Sep 23, 6:48 PM", direction: "inbound" },
    ];
  }
  return [
    { id: "m1", author: managerName, body: `Hi ${first}, your lease for ${place} is ready to sign.`, at: "Sep 25, 9:00 AM", direction: "outbound" },
    { id: "m2", author: name, body: "Got it, I'll review it tonight.", at: "Sep 25, 12:41 PM", direction: "inbound" },
  ];
}
