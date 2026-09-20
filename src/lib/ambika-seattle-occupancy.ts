/**
 * Ambika Seattle occupancy roster — PLAN-0918-1909 Decide answers baked in.
 *
 * Production copy listing ids only. Locked seed listing ids are never targets.
 * Listing advertised rent is never a field on these records.
 */

export const AMBIKA_MANAGER_ID = "c49d02b1-7e99-4484-9986-b3b4550c3519";
export const AMBIKA_MANAGER_EMAIL = "ogambik2@gmail.com";
export const PRODUCTION_PROJECT_REF = "qahnczmilgptcedaqype";

/** Captain-locked live seed listings — refuse any write that names these ids. */
export const LOCKED_LIVE_LISTING_IDS = [
  "mgr--9-rooms-b1wf3z",
  "mgr-seed-5259-brooklyn-ave-ne",
  "mgr-seed-4709a-8th-ave-ne",
] as const;

/** Ambika's live Seattle copies (not the locked seeds). */
export const AMBIKA_SEATTLE_PROPERTY_IDS = {
  "5257": "mgr-listing-1x3tiu0489ha",
  "5259": "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq",
  "4709A": "mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg",
} as const;

export type SeattleHouse = keyof typeof AMBIKA_SEATTLE_PROPERTY_IDS;

export const AMBIKA_SEATTLE_DECIDE = {
  properties: "seattle-three",
  airbnb: "bookings-only",
  room6: "baljinnyam",
  danielRoom: "5259-room-2",
  vivekRentCents: 100_000,
  prakritR9: "full-resident",
  alexander: "file-no-pdf",
  vinod: "booking-only",
  missingStarts: "first-paid-month",
  firstPaidMonthStart: "2026-09-01",
  onboard: "sms-or-email",
  existingRows: "update-terms",
} as const;

export type AmbikaSeattleResident = {
  key: string;
  house: SeattleHouse;
  roomNumber: number;
  name: string;
  /** Real inbox only. Placeholder import emails are derived, never invented Gmail. */
  email?: string;
  phone?: string;
  rentCents?: number;
  utilitiesCents?: number;
  start: string;
  end?: string;
  monthToMonth?: boolean;
  pdfFileName?: string;
  skipCharges?: boolean;
  onboard: boolean;
};

export type AmbikaSeattleBooking = {
  key: string;
  house: SeattleHouse;
  roomNumber: number;
  name: string;
  /** Inclusive first night. */
  start: string;
  /** Inclusive last night. */
  end: string;
  reason: "Airbnb" | "Booking";
};

export function isLockedLiveListingId(propertyId: string): boolean {
  return (LOCKED_LIVE_LISTING_IDS as readonly string[]).includes(propertyId.trim());
}

export function ambikaSeattlePropertyId(house: SeattleHouse): string {
  return AMBIKA_SEATTLE_PROPERTY_IDS[house];
}

export function occupancyPlaceholderEmail(name: string, roomNumber: number, house: SeattleHouse): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "guest";
  return `occupancy.${slug}.r${roomNumber}.${house.toLowerCase()}@import.proplane.local`;
}

export function residentEmailFor(row: AmbikaSeattleResident): string {
  return (row.email ?? occupancyPlaceholderEmail(row.name, row.roomNumber, row.house)).trim().toLowerCase();
}

export function roomIdForNumber(
  rooms: readonly { id?: string; name?: string }[],
  roomNumber: number,
): string | null {
  const target = `room ${roomNumber}`.replace(/\s+/g, " ").toLowerCase();
  const exact = rooms.find((r) => String(r.name ?? "").trim().toLowerCase().replace(/\s+/g, " ") === target);
  if (exact?.id) return exact.id;
  const byNum = rooms.find((r) => {
    const m = /^room\s*(\d+)$/i.exec(String(r.name ?? "").trim());
    return m && Number(m[1]) === roomNumber;
  });
  return byNum?.id ?? null;
}

const SEP = AMBIKA_SEATTLE_DECIDE.firstPaidMonthStart;

/** Long-term people after Decide. Airbnb names are not here. */
export const AMBIKA_SEATTLE_RESIDENTS: AmbikaSeattleResident[] = [
  {
    key: "grace-4709a-r1",
    house: "4709A",
    roomNumber: 1,
    name: "Grace Natalie Halverson",
    phone: "(715) 419-2818",
    rentCents: 72_500,
    utilitiesCents: 15_000,
    start: SEP,
    end: "2026-12-31",
    pdfFileName: "Lease Agreement Room1.pdf",
    onboard: true,
  },
  {
    key: "sohan-4709a-r2",
    house: "4709A",
    roomNumber: 2,
    name: "Sohan Vivek Naik",
    email: "sohanvnaik@gmail.com",
    start: "2026-09-21",
    skipCharges: true,
    pdfFileName: "Lease Sohan Room2.pdf",
    onboard: true,
  },
  {
    key: "aaron-4709a-r6",
    house: "4709A",
    roomNumber: 6,
    name: "Aaron",
    phone: "(305) 464-2975",
    rentCents: 72_500,
    utilitiesCents: 15_000,
    start: SEP,
    monthToMonth: true,
    pdfFileName: "Lease Aaron6.pdf",
    onboard: true,
  },
  {
    key: "daniel-5259-r2",
    house: "5259",
    roomNumber: 2,
    name: "Fekadu Daniel",
    phone: "(425) 583-6477",
    rentCents: 110_000,
    start: "2026-08-21",
    end: "2026-10-31",
    pdfFileName: "Lease Agreement Room 3 Daniel.pdf",
    onboard: true,
  },
  {
    key: "vivek-5259-r4",
    house: "5259",
    roomNumber: 4,
    name: "Vivek",
    phone: "(214) 687-1641",
    rentCents: AMBIKA_SEATTLE_DECIDE.vivekRentCents,
    start: SEP,
    onboard: true,
  },
  {
    key: "dashnyam-5259-r5",
    house: "5259",
    roomNumber: 5,
    name: "Dashnyam",
    phone: "(516) 613-1158",
    rentCents: 80_000,
    utilitiesCents: 20_000,
    start: "2026-09-01",
    end: "2027-02-28",
    pdfFileName: "Lease Dashnyam Room5.pdf",
    onboard: true,
  },
  {
    key: "baljinnyam-5259-r6",
    house: "5259",
    roomNumber: 6,
    name: "Baljinnyam",
    phone: "(206) 391-7572",
    rentCents: 80_000,
    utilitiesCents: 20_000,
    start: "2026-09-01",
    end: "2027-02-28",
    pdfFileName: "Lease Baljinnyam Room6-1.pdf",
    onboard: true,
  },
  {
    key: "ochirsaikhan-5259-r7",
    house: "5259",
    roomNumber: 7,
    name: "Ochirsaikhan",
    phone: "(814) 350-0145",
    rentCents: 80_000,
    utilitiesCents: 20_000,
    start: "2026-09-01",
    end: "2027-02-28",
    pdfFileName: "Lease Ochirsaikhan Room7.pdf",
    onboard: true,
  },
  {
    key: "dagvadorj-5259-r8",
    house: "5259",
    roomNumber: 8,
    name: "Dagvadorj",
    phone: "(516) 805-7270",
    rentCents: 80_000,
    utilitiesCents: 20_000,
    start: "2026-09-01",
    end: "2027-02-28",
    pdfFileName: "LeaseDagvadorjRoom8.pdf",
    onboard: true,
  },
  {
    key: "shivansh-5259-r9",
    house: "5259",
    roomNumber: 9,
    name: "Shivansh",
    phone: "(469) 355-5568",
    rentCents: 102_500,
    utilitiesCents: 17_500,
    start: "2026-08-15",
    end: "2026-11-08",
    pdfFileName: "Lease Shivansh Room 9 -1.pdf",
    onboard: true,
  },
  {
    key: "heesu-5257-r1",
    house: "5257",
    roomNumber: 1,
    name: "Heesu",
    phone: "(360) 890-1924",
    rentCents: 85_000,
    utilitiesCents: 15_000,
    start: SEP,
    end: "2027-08-31",
    pdfFileName: "Lease Heesu Room 1-1.pdf",
    onboard: true,
  },
  {
    key: "alexander-5257-r2",
    house: "5257",
    roomNumber: 2,
    name: "Alexander",
    rentCents: 80_000,
    utilitiesCents: 13_000,
    start: SEP,
    end: "2026-09-30",
    onboard: true,
  },
  {
    key: "akshaya-5257-r3",
    house: "5257",
    roomNumber: 3,
    name: "Akshaya Vinod Kumar",
    email: "akshaya.vk25@gmail.com",
    rentCents: 90_000,
    start: SEP,
    pdfFileName: "Lease Akshaya Room3.pdf",
    onboard: true,
  },
  {
    key: "riko-5257-r8",
    house: "5257",
    roomNumber: 8,
    name: "Riko",
    phone: "(206) 327-5264",
    rentCents: 85_000,
    utilitiesCents: 15_000,
    start: SEP,
    monthToMonth: true,
    pdfFileName: "Lease Riko Room 8.pdf",
    onboard: true,
  },
  {
    key: "prakrit-5257-r9",
    house: "5257",
    roomNumber: 9,
    name: "Prakrit",
    start: SEP,
    skipCharges: true,
    onboard: true,
  },
];

/** Calendar Airbnb / hold stays. No resident login, no onboard, no charges. */
export const AMBIKA_SEATTLE_BOOKINGS: AmbikaSeattleBooking[] = [
  { key: "andrew-4709a-r2", house: "4709A", roomNumber: 2, name: "Andrew", start: "2026-09-14", end: "2026-09-20", reason: "Airbnb" },
  { key: "dung-4709a-r3", house: "4709A", roomNumber: 3, name: "Dung", start: "2026-09-14", end: "2026-09-16", reason: "Airbnb" },
  { key: "ved-4709a-r3", house: "4709A", roomNumber: 3, name: "Ved", start: "2026-09-20", end: "2026-09-30", reason: "Airbnb" },
  { key: "alua-4709a-r4", house: "4709A", roomNumber: 4, name: "Alua", start: "2026-09-14", end: "2026-09-21", reason: "Airbnb" },
  { key: "precious-4709a-r5", house: "4709A", roomNumber: 5, name: "Precious", start: "2026-09-14", end: "2026-09-16", reason: "Airbnb" },
  { key: "vinod-4709a-r5", house: "4709A", roomNumber: 5, name: "Vinod", start: "2026-09-17", end: "2026-09-30", reason: "Booking" },
  { key: "anna-4709a-r7", house: "4709A", roomNumber: 7, name: "Anna", start: "2026-09-14", end: "2026-09-25", reason: "Airbnb" },
  { key: "vikrant-4709a-r8", house: "4709A", roomNumber: 8, name: "Vikrant", start: "2026-09-14", end: "2026-09-25", reason: "Airbnb" },
  { key: "karthik-4709a-r9", house: "4709A", roomNumber: 9, name: "Karthik", start: "2026-09-14", end: "2026-09-30", reason: "Airbnb" },
  { key: "khue-4709a-r10", house: "4709A", roomNumber: 10, name: "Khue", start: "2026-09-14", end: "2026-09-30", reason: "Airbnb" },
  { key: "yan-5259-r1", house: "5259", roomNumber: 1, name: "Yan", start: "2026-09-14", end: "2026-09-22", reason: "Airbnb" },
  { key: "franco-5259-r3", house: "5259", roomNumber: 3, name: "Franco", start: "2026-09-15", end: "2026-09-18", reason: "Airbnb" },
  { key: "minjun-5257-r4", house: "5257", roomNumber: 4, name: "Minjun", start: "2026-09-14", end: "2026-09-19", reason: "Airbnb" },
  { key: "james-5257-r5", house: "5257", roomNumber: 5, name: "James", start: "2026-09-14", end: "2026-09-14", reason: "Airbnb" },
  { key: "selina-5257-r5", house: "5257", roomNumber: 5, name: "Selina", start: "2026-09-15", end: "2026-09-18", reason: "Airbnb" },
  { key: "daiyun-5257-r5", house: "5257", roomNumber: 5, name: "Daiyun", start: "2026-09-23", end: "2026-09-23", reason: "Airbnb" },
  { key: "shaurya-5257-r6", house: "5257", roomNumber: 6, name: "Shaurya", start: "2026-09-14", end: "2026-09-16", reason: "Airbnb" },
  { key: "chinese-5257-r6", house: "5257", roomNumber: 6, name: "Chinese", start: "2026-09-19", end: "2026-09-22", reason: "Airbnb" },
  { key: "airbnb-daniel-5257-r7", house: "5257", roomNumber: 7, name: "Daniel", start: "2026-09-14", end: "2026-09-23", reason: "Airbnb" },
];

export function bookingGetsOnboard(_booking: AmbikaSeattleBooking): false {
  return false;
}

function ambikaNamesOverlap(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** Signed leases on disk whose resident row deliberately carries no pdfFileName. */
export const AMBIKA_EXTRA_LEASE_PDFS: Record<string, string> = {
  vivek: "Lease Vivek Room4.pdf",
};

/** Roster row for a lease record: email is exact, then the exact name, and only then a substring overlap. */
export function ambikaResidentForLease(
  residentName: string,
  residentEmail?: string | null,
): AmbikaSeattleResident | null {
  const email = (residentEmail ?? "").trim().toLowerCase();
  if (email) {
    const byEmail = AMBIKA_SEATTLE_RESIDENTS.find(
      (row) => residentEmailFor(row) === email || row.email?.trim().toLowerCase() === email,
    );
    if (byEmail) return byEmail;
  }
  const key = residentName.trim().toLowerCase();
  if (!key) return null;
  const exact = AMBIKA_SEATTLE_RESIDENTS.find((row) => row.name.trim().toLowerCase() === key);
  if (exact) return exact;
  return (
    AMBIKA_SEATTLE_RESIDENTS.find((row) => row.pdfFileName && ambikaNamesOverlap(row.name, residentName)) ??
    AMBIKA_SEATTLE_RESIDENTS.find((row) => ambikaNamesOverlap(row.name, residentName)) ??
    null
  );
}

export function leasePdfFileNameFor(residentName: string, residentEmail?: string | null): string | null {
  const key = residentName.trim().toLowerCase();
  if (key.includes("armbrister")) return null;
  const stay = ambikaResidentForLease(residentName, residentEmail);
  if (stay?.pdfFileName) return stay.pdfFileName;
  const extraKey = (stay?.name ?? residentName).trim().toLowerCase();
  for (const [needle, file] of Object.entries(AMBIKA_EXTRA_LEASE_PDFS)) {
    if (extraKey.includes(needle)) return file;
  }
  return null;
}

/** Inclusive last night → exclusive checkout for a room-date block. */
export function exclusiveCheckoutAfterLastNight(inclusiveEnd: string): string {
  const [y, m, d] = inclusiveEnd.split("-").map(Number);
  if (!y || !m || !d) return inclusiveEnd;
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}
