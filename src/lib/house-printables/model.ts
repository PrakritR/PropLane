/**
 * House printables — the door card, the house-rules poster, the welcome sheet,
 * and the public page a scanned QR opens.
 *
 * Every field these draw already exists on the listing: `houseInfo` holds the
 * codes, the Wi-Fi, the trash day and the rules; the submission holds the name
 * and address; the rooms hold their own move-in notes. This module only decides
 * WHICH of those may appear WHERE, because the three surfaces have three
 * different audiences:
 *
 *   - The door card and the poster hang in public and their QR opens a URL
 *     anyone can scan — a delivery driver, a neighbour, a resident from two
 *     years ago. Nothing that opens a door or a network may be on them, and the
 *     page they point at is built ONLY from {@link buildHousePublicPage}, which
 *     reads the rules and trash sections and nothing else.
 *   - The welcome sheet is handed to one resident on paper. It carries the codes
 *     and the Wi-Fi precisely because it never becomes a URL; it is rendered
 *     behind the manager's session and printed.
 *
 * `tests/unit/house-printables-privacy.test.ts` proves the public model cannot
 * carry a value from the access, wifi, contacts, safety or laundry sections.
 */
import {
  HOUSE_INFO_SECTIONS,
  getHouseInfoValue,
  normalizeHouseInfo,
  type HouseInfoSectionId,
  type HouseInfoV1,
} from "@/lib/house-info";
import {
  listingSubmissionCityZipLine,
  listingSubmissionStreetLine,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

/** Sections that may reach the public page and the two public printables. */
export const HOUSE_PUBLIC_SECTIONS: readonly HouseInfoSectionId[] = ["rules", "trash"] as const;

/** Sections that never leave the manager's session or the resident's own sheet. */
export const HOUSE_PRIVATE_SECTIONS: readonly HouseInfoSectionId[] = [
  "access",
  "wifi",
  "contacts",
  "safety",
  "laundry",
] as const;

export type HousePrintableLine = { label: string; value: string };

export type HousePublicPage = {
  name: string;
  street: string;
  cityZip: string;
  quietHours: string | null;
  rules: HousePrintableLine[];
  /** The legacy free-text rules, only when no structured rule is filled. */
  rulesText: string | null;
  trash: HousePrintableLine[];
  /** E.164 work number the "Text the manager" button opens, or null for no button. */
  smsPhone: string | null;
  updatedAt: string | null;
};

type SubmissionSource = Pick<
  ManagerListingSubmissionV1,
  "buildingName" | "address" | "city" | "state" | "neighborhood" | "zip" | "houseRulesText" | "houseInfo"
>;

function houseName(sub: SubmissionSource): string {
  return sub.buildingName?.trim() || listingSubmissionStreetLine(sub) || "This house";
}

/** The address line under the name — without repeating a street that IS the name. */
export function houseAddressLine(model: { name: string; street: string; cityZip: string }): string {
  const parts = model.street && model.street !== model.name ? [model.street, model.cityZip] : [model.cityZip];
  return parts.filter(Boolean).join(", ");
}

function formatClock(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return value.trim();
  const hour = Number(m[1]);
  const minute = m[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === "00" ? `${twelve} ${suffix}` : `${twelve}:${minute} ${suffix}`;
}

function sectionLines(info: HouseInfoV1, sectionId: HouseInfoSectionId, skipKeys: ReadonlySet<string>): HousePrintableLine[] {
  const spec = HOUSE_INFO_SECTIONS.find((s) => s.id === sectionId);
  if (!spec) return [];
  const lines: HousePrintableLine[] = [];
  for (const field of spec.fields) {
    if (field.pairKey || skipKeys.has(field.key)) continue;
    const value = getHouseInfoValue(info, sectionId, field.key);
    if (value) lines.push({ label: field.label, value });
  }
  return lines;
}

const TRASH_PUBLIC_KEYS = new Set(["day", "recycling", "cleaningCadence"]);

/**
 * What anyone who scans the door card may read. Built from the rules and trash
 * sections by allowlist — the private sections are never even looked at.
 */
export function buildHousePublicPage(
  sub: SubmissionSource,
  opts: { smsPhone?: string | null; updatedAt?: string | null } = {},
): HousePublicPage {
  const info = normalizeHouseInfo(sub.houseInfo);
  const quietFrom = getHouseInfoValue(info, "rules", "quietFrom");
  const quietTo = getHouseInfoValue(info, "rules", "quietTo");
  const rules = sectionLines(info, "rules", new Set());
  const trashAll = sectionLines(info, "trash", new Set());
  const trashSpec = HOUSE_INFO_SECTIONS.find((s) => s.id === "trash");
  const trash = trashAll.filter((line) => {
    const key = trashSpec?.fields.find((f) => f.label === line.label)?.key;
    return key ? TRASH_PUBLIC_KEYS.has(key) : false;
  });
  return {
    name: houseName(sub),
    street: listingSubmissionStreetLine(sub),
    cityZip: listingSubmissionCityZipLine(sub),
    quietHours: quietFrom && quietTo ? `${formatClock(quietFrom)} – ${formatClock(quietTo)}` : null,
    rules,
    rulesText: rules.length === 0 && !(quietFrom && quietTo) ? sub.houseRulesText?.trim() || null : null,
    trash,
    smsPhone: opts.smsPhone?.trim() || null,
    updatedAt: opts.updatedAt ?? null,
  };
}

export function housePublicPageIsEmpty(page: HousePublicPage): boolean {
  return page.rules.length === 0 && page.trash.length === 0 && !page.quietHours && !page.rulesText;
}

export type HouseDoorCard = {
  name: string;
  street: string;
  cityZip: string;
  /** The public page URL the QR encodes. */
  url: string;
  smsPhone: string | null;
};

export function buildHouseDoorCard(sub: SubmissionSource, opts: { url: string; smsPhone?: string | null }): HouseDoorCard {
  return {
    name: houseName(sub),
    street: listingSubmissionStreetLine(sub),
    cityZip: listingSubmissionCityZipLine(sub),
    url: opts.url,
    smsPhone: opts.smsPhone?.trim() || null,
  };
}

export type HouseWelcomeSheet = {
  name: string;
  street: string;
  cityZip: string;
  residentName: string | null;
  roomLabel: string | null;
  floorLabel: string | null;
  /** Codes and Wi-Fi — paper only. */
  access: HousePrintableLine[];
  wifi: HousePrintableLine[];
  roomInstructions: string | null;
  /** The resident portal URL the QR encodes — a login, never a secret. */
  portalUrl: string;
  smsPhone: string | null;
};

export function buildHouseWelcomeSheet(
  sub: SubmissionSource & { rooms?: ReadonlyArray<{ id: string; name: string; floor: string; moveInInstructions?: string }> },
  opts: { portalUrl: string; roomId?: string | null; residentName?: string | null; smsPhone?: string | null },
): HouseWelcomeSheet {
  const info = normalizeHouseInfo(sub.houseInfo);
  const room = opts.roomId ? (sub.rooms ?? []).find((r) => r.id === opts.roomId) ?? null : null;
  return {
    name: houseName(sub),
    street: listingSubmissionStreetLine(sub),
    cityZip: listingSubmissionCityZipLine(sub),
    residentName: opts.residentName?.trim() || null,
    roomLabel: room?.name?.trim() || null,
    floorLabel: room?.floor?.trim() || null,
    access: sectionLines(info, "access", new Set()),
    wifi: sectionLines(info, "wifi", new Set()),
    roomInstructions: room?.moveInInstructions?.trim() || null,
    portalUrl: opts.portalUrl,
    smsPhone: opts.smsPhone?.trim() || null,
  };
}

/** Every value stored in the private sections — what a public model must never contain. */
export function housePrivateValues(sub: Pick<SubmissionSource, "houseInfo">): string[] {
  const info = normalizeHouseInfo(sub.houseInfo);
  const values: string[] = [];
  for (const sectionId of HOUSE_PRIVATE_SECTIONS) {
    for (const value of Object.values(info[sectionId])) if (value) values.push(value);
  }
  return values;
}
