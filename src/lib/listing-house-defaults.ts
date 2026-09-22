/**
 * House defaults for the create-listing wizard.
 *
 * A ten-room house is usually ten near-identical rooms, and the old wizard made
 * a manager re-type every field for each one. The redesign sets what is true for
 * MOST rooms once, and each room only stores what genuinely differs.
 *
 * ## How "inherited" is decided
 *
 * There is deliberately no per-room "isOverridden" flag. A room inherits a field
 * when its stored value EQUALS the house default (or is empty); it overrides when
 * the value differs. That means a room a manager happens to set to the same value
 * as the default is treated as inheriting, and will follow a later change to the
 * default. That is the intended behaviour — "this room is $1,050 like the rest"
 * should keep tracking the rest — and it keeps the room rows free of hidden state
 * that could disagree with what is on screen.
 *
 * ## The one hard safety rule
 *
 * Defaults NEVER touch `rentBasis` or `dailyRentPrice`. Per
 * `docs/agents/rent-basis.md`, a daily basis must only ever be set by an explicit
 * act of the manager on that room, because it changes how every rent charge is
 * billed. Inheritance carries the monthly figure and nothing else about billing.
 */
import type { ManagerListingSubmissionV1, ManagerRoomSubmission, ManagerRoomTermPrice } from "@/lib/manager-listing-submission";
import { bedsLine, parseBedsLine } from "@/lib/manager-listing-submission";
import type { UtilitiesPaymentModel } from "@/lib/listing-utilities-payment";

/** The fields a manager can set once for the whole house. */
export type ListingHouseDefaults = {
  monthlyRent: number;
  floor: string;
  securityDeposit: string;
  moveInFee: string;
  utilitiesEstimate: string;
  utilitiesPaymentModel: UtilitiesPaymentModel | "";
  furnishing: string;
  roomAmenitiesText: string;
  occupancyCapacity: number;
  /** "Twin × 2, Queen × 1" — the beds most rooms have. See `bedsLine` / `parseBedsLine`. */
  bedsLine: string;
  moveInInspectionRequired: boolean;
  moveOutInspectionRequired: boolean;
  /** Square footage most rooms share, when they are near enough alike. */
  sizeSqft: number;
  /** How a partial first or last month is split. Never a headline price. */
  prorateMethod: "auto" | "daily_rate" | "";
  /** Whether the advertised price invites an offer. Never changes the figure. */
  pricingMode: "fixed" | "flexible" | "";
  /**
   * A rate per lease type, so the defaults row can answer every question a room
   * can. `rentBasis` and the daily PRICE are still never defaulted — those
   * decide how rent is billed, which stays an explicit act on the room.
   */
  weeklyRentPrice: number;
  shortTermRent: string;
  shortTermDeposit: string;
  shortTermMoveInFee: string;
  dailyRentRate: number;
  dailyUtilitiesRate: number;
  /**
   * Media and words most rooms share — the "generic" pictures, clip, blurb and
   * move-in notes a room shows until it has its own. An empty list, `null` or
   * `""` is unset. Lists compare by value, so two rooms holding the same three
   * URLs both follow the house.
   */
  photoDataUrls: string[];
  videoDataUrl: string | null;
  detail: string;
  moveInInstructions: string;
  moveInPhotoDataUrls: string[];
  moveInVideoDataUrl: string | null;
};

export type ListingHouseDefaultField = keyof ListingHouseDefaults;

/** The list-valued fields — compared by value, inferred only when every room agrees. */
export const LISTING_HOUSE_DEFAULT_LIST_FIELDS: readonly ListingHouseDefaultField[] = ["photoDataUrls", "moveInPhotoDataUrls"];
/** Pictures, clips and words: a room that has its own keeps them even while the house has none. */
export const LISTING_HOUSE_DEFAULT_MEDIA_FIELDS: readonly ListingHouseDefaultField[] = [
  "photoDataUrls",
  "videoDataUrl",
  "detail",
  "moveInInstructions",
  "moveInPhotoDataUrls",
  "moveInVideoDataUrl",
];

/** Every default field, in the order the band renders them. */
export const LISTING_HOUSE_DEFAULT_FIELDS: readonly ListingHouseDefaultField[] = [
  "monthlyRent",
  "floor",
  "securityDeposit",
  "moveInFee",
  "utilitiesEstimate",
  "utilitiesPaymentModel",
  "furnishing",
  "roomAmenitiesText",
  "occupancyCapacity",
  "bedsLine",
  "moveInInspectionRequired",
  "moveOutInspectionRequired",
  "sizeSqft",
  "prorateMethod",
  "pricingMode",
  "weeklyRentPrice",
  "shortTermRent",
  "shortTermDeposit",
  "shortTermMoveInFee",
  "dailyRentRate",
  "dailyUtilitiesRate",
  "photoDataUrls",
  "videoDataUrl",
  "detail",
  "moveInInstructions",
  "moveInPhotoDataUrls",
  "moveInVideoDataUrl",
] as const;

export function emptyListingHouseDefaults(): ListingHouseDefaults {
  return {
    monthlyRent: 0,
    floor: "",
    securityDeposit: "",
    moveInFee: "",
    utilitiesEstimate: "",
    utilitiesPaymentModel: "",
    furnishing: "",
    roomAmenitiesText: "",
    occupancyCapacity: 1,
    bedsLine: "",
    moveInInspectionRequired: false,
    moveOutInspectionRequired: false,
    sizeSqft: 0,
    prorateMethod: "",
    pricingMode: "",
    weeklyRentPrice: 0,
    shortTermRent: "",
    shortTermDeposit: "",
    shortTermMoveInFee: "",
    dailyRentRate: 0,
    dailyUtilitiesRate: 0,
    photoDataUrls: [],
    videoDataUrl: null,
    detail: "",
    moveInInstructions: "",
    moveInPhotoDataUrls: [],
    moveInVideoDataUrl: null,
  };
}

/** The value a room currently holds for one default field. */
export function roomDefaultFieldValue(
  room: ManagerRoomSubmission,
  field: ListingHouseDefaultField,
): ListingHouseDefaults[ListingHouseDefaultField] {
  switch (field) {
    case "monthlyRent":
      return room.monthlyRent ?? 0;
    case "floor":
      return (room.floor ?? "").trim();
    case "securityDeposit":
      return (room.securityDeposit ?? "").trim();
    case "moveInFee":
      return (room.moveInFee ?? "").trim();
    case "utilitiesEstimate":
      return (room.utilitiesEstimate ?? "").trim();
    case "utilitiesPaymentModel":
      return room.utilitiesPaymentModel ?? "";
    case "furnishing":
      return (room.furnishing ?? "").trim();
    case "roomAmenitiesText":
      return (room.roomAmenitiesText ?? "").trim();
    case "occupancyCapacity":
      return room.occupancyCapacity ?? 1;
    case "bedsLine":
      return bedsLine(room.beds);
    case "moveInInspectionRequired":
      return room.moveInInspectionRequired === true;
    case "moveOutInspectionRequired":
      return room.moveOutInspectionRequired === true;
    case "sizeSqft":
      return room.sizeSqft ?? 0;
    case "prorateMethod":
      return room.prorateMethod ?? "";
    case "pricingMode":
      return room.pricingMode ?? "";
    case "weeklyRentPrice":
      return room.weeklyRentPrice ?? 0;
    case "shortTermRent":
      return (room.shortTermRent ?? "").trim();
    case "shortTermDeposit":
      return (room.shortTermDeposit ?? "").trim();
    case "shortTermMoveInFee":
      return (room.shortTermMoveInFee ?? "").trim();
    case "dailyRentRate":
      return room.dailyRentRate ?? 0;
    case "dailyUtilitiesRate":
      return room.dailyUtilitiesRate ?? 0;
    case "photoDataUrls":
      return room.photoDataUrls ?? [];
    case "videoDataUrl":
      return room.videoDataUrl ?? null;
    case "detail":
      return (room.detail ?? "").trim();
    case "moveInInstructions":
      return (room.moveInInstructions ?? "").trim();
    case "moveInPhotoDataUrls":
      return room.moveInPhotoDataUrls ?? [];
    case "moveInVideoDataUrl":
      return room.moveInVideoDataUrl ?? null;
  }
}

function writeRoomDefaultField(
  room: ManagerRoomSubmission,
  field: ListingHouseDefaultField,
  defaults: ListingHouseDefaults,
): ManagerRoomSubmission {
  switch (field) {
    case "monthlyRent":
      return { ...room, monthlyRent: defaults.monthlyRent };
    case "floor":
      return { ...room, floor: defaults.floor };
    case "securityDeposit":
      return { ...room, securityDeposit: defaults.securityDeposit };
    case "moveInFee":
      return { ...room, moveInFee: defaults.moveInFee };
    case "utilitiesEstimate":
      return { ...room, utilitiesEstimate: defaults.utilitiesEstimate };
    case "utilitiesPaymentModel":
      return defaults.utilitiesPaymentModel
        ? { ...room, utilitiesPaymentModel: defaults.utilitiesPaymentModel }
        : room;
    case "furnishing":
      return { ...room, furnishing: defaults.furnishing };
    case "roomAmenitiesText":
      return { ...room, roomAmenitiesText: defaults.roomAmenitiesText };
    case "occupancyCapacity":
      return { ...room, occupancyCapacity: defaults.occupancyCapacity };
    case "bedsLine": {
      if (!defaults.bedsLine.trim()) return room;
      const beds = parseBedsLine(defaults.bedsLine);
      return { ...room, beds, bedCount: beds.reduce((n, b) => n + b.count, 0) };
    }
    case "moveInInspectionRequired":
      return { ...room, moveInInspectionRequired: defaults.moveInInspectionRequired };
    case "moveOutInspectionRequired":
      return { ...room, moveOutInspectionRequired: defaults.moveOutInspectionRequired };
    case "sizeSqft":
      return defaults.sizeSqft > 0 ? { ...room, sizeSqft: defaults.sizeSqft } : room;
    case "prorateMethod":
      return defaults.prorateMethod ? { ...room, prorateMethod: defaults.prorateMethod } : room;
    case "pricingMode":
      return defaults.pricingMode ? { ...room, pricingMode: defaults.pricingMode } : room;
    case "weeklyRentPrice":
      return defaults.weeklyRentPrice > 0 ? { ...room, weeklyRentPrice: defaults.weeklyRentPrice } : room;
    case "shortTermRent":
      return { ...room, shortTermRent: defaults.shortTermRent };
    case "shortTermDeposit":
      return { ...room, shortTermDeposit: defaults.shortTermDeposit };
    case "shortTermMoveInFee":
      return { ...room, shortTermMoveInFee: defaults.shortTermMoveInFee };
    case "dailyRentRate":
      return defaults.dailyRentRate > 0 ? { ...room, dailyRentRate: defaults.dailyRentRate } : room;
    case "dailyUtilitiesRate":
      return defaults.dailyUtilitiesRate > 0 ? { ...room, dailyUtilitiesRate: defaults.dailyUtilitiesRate } : room;
    // Media and words copy as they are, blank included: a room that is "the
    // same as the house" shows the house's pictures, and none when the house
    // has none. Each room keeps its own copy of the URLs, so every reader
    // downstream — the public listing, the preview, the assistant — sees a
    // plain room with plain photos and learns no new concept.
    case "photoDataUrls":
      return { ...room, photoDataUrls: [...defaults.photoDataUrls] };
    case "videoDataUrl":
      return { ...room, videoDataUrl: defaults.videoDataUrl };
    case "detail":
      return { ...room, detail: defaults.detail };
    case "moveInInstructions":
      return { ...room, moveInInstructions: defaults.moveInInstructions };
    case "moveInPhotoDataUrls":
      return { ...room, moveInPhotoDataUrls: [...defaults.moveInPhotoDataUrls] };
    case "moveInVideoDataUrl":
      return { ...room, moveInVideoDataUrl: defaults.moveInVideoDataUrl };
  }
}

/* ─────────────── rent per resident is a room's own state ─────────────── */

/**
 * The Default-card fields a room priced per resident owns outright. Never the
 * Default card's own fields: `residentPricing` / `residentPrices` are a room's
 * answer for ITS residents, and there is no "most rooms" figure for them.
 */
const RESIDENT_PRICING_OWN_FIELDS: ReadonlySet<ListingHouseDefaultField> = new Set([
  "monthlyRent",
  "utilitiesEstimate",
  "securityDeposit",
]);

/**
 * Whether the room (or, with `term`, that lease type's entry) carries its own
 * per-resident rows. Such a room is "own" for the Same-as-default-room tick on
 * every price field, and a default change never reaches it (PLAN-0920-0631).
 */
export function roomHasResidentPricing(room: ManagerRoomSubmission, term?: string | null): boolean {
  const t = String(term ?? "").trim();
  if (t) {
    const entry = room.termPricing?.[t];
    if (entry?.residentPricing === "same") return false;
    if (entry?.residentPricing === "per_resident") return (entry.residentPrices?.length ?? 0) > 0;
  }
  return room.residentPricing === "per_resident" && (room.residentPrices?.length ?? 0) > 0;
}

/**
 * Untick "Different rent per resident" — on the room, or with `term` on that
 * lease type's entry only. The room's own figures are untouched, so Review, the
 * applicant's room list and the lease keep reading a priced room.
 */
export function clearRoomResidentPricing(room: ManagerRoomSubmission, term?: string | null): ManagerRoomSubmission {
  const t = String(term ?? "").trim();
  if (t) {
    const entry = room.termPricing?.[t];
    if (!entry) return room;
    const { residentPricing: _flag, residentPrices: _rows, ...rest } = entry;
    void _flag;
    void _rows;
    const all = { ...(room.termPricing ?? {}) };
    if (Object.keys(rest).length === 0) delete all[t];
    else all[t] = rest;
    return { ...room, termPricing: Object.keys(all).length > 0 ? all : undefined };
  }
  if (room.residentPricing === undefined && room.residentPrices === undefined) return room;
  const { residentPricing: _flag, residentPrices: _rows, ...rest } = room;
  void _flag;
  void _rows;
  return rest;
}

/** An unset value — treated as inheriting rather than as a deliberate blank. */
function isUnset(value: ListingHouseDefaults[ListingHouseDefaultField]): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return value <= 0;
  return false; // a boolean is always a real answer
}

/** Equal by value — a list of URLs is the same list when its members are. */
function sameValue(a: ListingHouseDefaults[ListingHouseDefaultField], b: ListingHouseDefaults[ListingHouseDefaultField]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

/**
 * Is this room following the house default for this field?
 *
 * True when the room's value matches the default, when the room has no value at
 * all (a blank room is showing the default, so editing the default must fill it
 * in), and when the HOUSE has no default — there is nothing to diverge from, so
 * a room cannot be overriding it.
 */
export function roomInheritsDefault(
  room: ManagerRoomSubmission,
  defaults: ListingHouseDefaults,
  field: ListingHouseDefaultField,
): boolean {
  // A room priced per resident is its own room on every price field: the card's
  // one rent is not what its residents pay, so a default change must not reach it
  // and the Same-as-default-room tick reads unticked.
  if (RESIDENT_PRICING_OWN_FIELDS.has(field) && roomHasResidentPricing(room)) return false;
  const roomValue = roomDefaultFieldValue(room, field);
  const defaultValue = defaults[field];
  if (typeof roomValue === "boolean" || typeof defaultValue === "boolean") return roomValue === defaultValue;
  // Pictures, clips and words are the room's own the moment it has any while
  // the house has none: the first house photos must never sweep away a room's.
  // A fact (floor, rent, size) keeps the older rule — with no house value there
  // is nothing to diverge from, and the first default fills the blanks.
  if (isUnset(defaultValue)) return LISTING_HOUSE_DEFAULT_MEDIA_FIELDS.includes(field) ? isUnset(roomValue) : true;
  if (isUnset(roomValue)) return true;
  return sameValue(roomValue, defaultValue);
}

/** The fields this room has deliberately set differently from the house. */
export function roomOverriddenDefaults(
  room: ManagerRoomSubmission,
  defaults: ListingHouseDefaults,
): ListingHouseDefaultField[] {
  return LISTING_HOUSE_DEFAULT_FIELDS.filter((field) => !roomInheritsDefault(room, defaults, field));
}

/**
 * The rooms that have not diverged on ANY field.
 *
 * This is the per-ROOM reading the previous wizard (`pro-add-listing-form`)
 * still uses: once a room differs anywhere, that wizard stops moving it at
 * all. The v2 Rooms step no longer calls it — there a room follows the Default
 * room field by field, exactly as {@link applyHouseDefaultsToRooms} judges it,
 * so a room on its own floor still picks up a new default size or checklist.
 * An explicit untick of "Same as default room" is the only whole-room freeze.
 */
export function roomsFollowingDefaults(
  rooms: readonly ManagerRoomSubmission[],
  defaults: ListingHouseDefaults,
): string[] {
  return rooms.filter((room) => roomOverriddenDefaults(room, defaults).length === 0).map((room) => room.id);
}

/**
 * Push the house defaults onto every room that is still following them.
 *
 * A room that overrides a field keeps its own value for THAT field only — it still
 * inherits every other field, so overriding rent never freezes the room's
 * furnishing. `onlyFields` narrows the write to one column, which is what the
 * "copy down" control on a column header uses.
 */
export function applyHouseDefaultsToRooms(
  rooms: readonly ManagerRoomSubmission[],
  defaults: ListingHouseDefaults,
  opts: {
    onlyFields?: readonly ListingHouseDefaultField[];
    roomIds?: readonly string[];
    /**
     * The defaults as they were BEFORE this edit. Inheritance has to be judged
     * against the old value: a room sitting at $1,050 when the default was
     * $1,050 was following the house, and must move to $1,100 when the house
     * does. Comparing against the NEW default instead would read every room as
     * having diverged and freeze them all — which is exactly the bug this
     * parameter exists to prevent. Omit it only when nothing changed.
     */
    previousDefaults?: ListingHouseDefaults;
  } = {},
): ManagerRoomSubmission[] {
  const fields = opts.onlyFields ?? LISTING_HOUSE_DEFAULT_FIELDS;
  const scope = opts.roomIds ? new Set(opts.roomIds) : null;
  const judgeAgainst = opts.previousDefaults ?? defaults;
  return rooms.map((room) => {
    if (scope && !scope.has(room.id)) return room;
    let next = room;
    for (const field of fields) {
      // `roomIds` is an explicit "apply to these rooms" instruction from the
      // manager, so it overwrites; a plain default change only reaches rooms
      // that had not diverged.
      if (scope || roomInheritsDefault(room, judgeAgainst, field)) {
        next = writeRoomDefaultField(next, field, defaults);
      }
    }
    return next;
  });
}

/** The three prices the Pricing step's Default room sets on the long-term tab. */
export const LISTING_HOUSE_PRICE_FIELDS: readonly ListingHouseDefaultField[] = ["monthlyRent", "utilitiesEstimate", "securityDeposit"];

/**
 * Put ONE of a room's fields back on the Default card — the ↺ in a cell and
 * the "Same as default room" tick. The room keeps its own COPY of the card's
 * value, blank included: the record is what Review, the applicant's room
 * list, the signed lease and the public page read, and none of them resolve
 * the card. Blanking the field instead (what the Pricing step once did) drew
 * "$1,050 · Same as default room" on screen while the record held $0.
 */
export function resetRoomFieldToDefault(
  room: ManagerRoomSubmission,
  field: ListingHouseDefaultField,
  defaults: ListingHouseDefaults,
): ManagerRoomSubmission {
  const blank = emptyListingHouseDefaults();
  // Reset on a price field also unticks "Different rent per resident": the room
  // goes back on the card as one room with one rent, never a card rent beside
  // resident rows that no longer match it.
  const base = RESIDENT_PRICING_OWN_FIELDS.has(field) ? clearRoomResidentPricing(room) : room;
  const cleared = writeRoomDefaultField(base, field, blank);
  return applyHouseDefaultsToRooms([cleared], defaults, { onlyFields: [field], roomIds: [room.id] })[0]!;
}

/**
 * Fill every room still following the Default card on `fields` with the
 * card's value — the one-time repair for a listing saved while the Pricing
 * step blanked followers. Writes only where the card holds a value and the
 * room does not; a room with its own number is left alone. Returns the same
 * array when nothing changes, so a caller can patch only on a real change.
 */
export function fillRoomsFollowingDefaults(
  rooms: readonly ManagerRoomSubmission[],
  defaults: ListingHouseDefaults,
  fields: readonly ListingHouseDefaultField[] = LISTING_HOUSE_PRICE_FIELDS,
): readonly ManagerRoomSubmission[] {
  let changed = false;
  const out = rooms.map((room) => {
    let next = room;
    for (const field of fields) {
      // Unset on the room while the card holds a value is exactly "following":
      // the Pricing step already draws the card's number there.
      if (isUnset(defaults[field]) || !isUnset(roomDefaultFieldValue(room, field))) continue;
      next = writeRoomDefaultField(next, field, defaults);
    }
    if (next !== room) changed = true;
    return next;
  });
  return changed ? out : rooms;
}

/**
 * Guess sensible defaults from rooms that already exist, so opening an older
 * listing in the new wizard does not show an empty band. Uses the most common
 * value per field (ties resolve to the first room), which is what "most rooms
 * are…" means.
 */
export function inferHouseDefaultsFromRooms(rooms: readonly ManagerRoomSubmission[]): ListingHouseDefaults {
  const defaults = emptyListingHouseDefaults();
  if (rooms.length === 0) return defaults;
  const out = { ...defaults } as Record<string, unknown>;
  for (const field of LISTING_HOUSE_DEFAULT_FIELDS) {
    // A photo list is the house's only when EVERY room carries the same one.
    // Majority would crown one room's pictures as "the default" the moment two
    // rooms happened to share them, and then push them onto a third.
    if (LISTING_HOUSE_DEFAULT_LIST_FIELDS.includes(field) || field === "videoDataUrl" || field === "moveInVideoDataUrl") {
      const first = roomDefaultFieldValue(rooms[0]!, field);
      if (!isUnset(first) && rooms.every((room) => sameValue(roomDefaultFieldValue(room, field), first))) out[field] = first;
      continue;
    }
    const counts = new Map<string, { value: unknown; n: number }>();
    for (const room of rooms) {
      const value = roomDefaultFieldValue(room, field);
      if (isUnset(value)) continue;
      const key = String(value);
      const hit = counts.get(key);
      if (hit) hit.n += 1;
      else counts.set(key, { value, n: 1 });
    }
    let best: { value: unknown; n: number } | null = null;
    for (const entry of counts.values()) {
      if (!best || entry.n > best.n) best = entry;
    }
    if (best) out[field] = best.value;
  }
  return out as unknown as ListingHouseDefaults;
}

/** Read the defaults a submission carries, falling back to what its rooms imply. */
export function houseDefaultsForSubmission(sub: ManagerListingSubmissionV1): ListingHouseDefaults {
  const stored = sub.houseDefaults;
  const inferred = inferHouseDefaultsFromRooms(sub.rooms ?? []);
  if (!stored) return inferred;
  return { ...inferred, ...stored };
}

/* ─────────────── the Default room on another lease type ─────────────── */

/**
 * The three prices the Pricing step's Default room sets on a lease type other
 * than long-term. A block shaped like a room's `termPricing` holds them
 * (`sub.houseTermPricing`); a room follows the block per field, with the same
 * reading as the long-term defaults above: absent or equal is following, and a
 * different number is the room's own.
 *
 * The one difference from long-term: with NO term default set, a room that
 * already has its own price on the term keeps it when the first default is
 * typed. The manager put that number there on purpose while the card above
 * was empty, and the first default must not sweep it away.
 */
export type ListingTermPriceField = "monthlyRent" | "utilitiesEstimate" | "securityDeposit";

export const LISTING_TERM_PRICE_FIELDS: readonly ListingTermPriceField[] = ["monthlyRent", "utilitiesEstimate", "securityDeposit"];

export type ListingHouseTermPricing = Record<string, ManagerRoomTermPrice>;

/** One term-price field as the text a money box shows; `""` when unset. */
export function termPriceFieldText(entry: ManagerRoomTermPrice | undefined, field: ListingTermPriceField): string {
  if (!entry) return "";
  if (field === "monthlyRent") return typeof entry.monthlyRent === "number" && entry.monthlyRent > 0 ? String(entry.monthlyRent) : "";
  return (entry[field] ?? "").replace(/^\$/, "").trim();
}

/**
 * Write one field of one term's entry; an empty value clears that field, and
 * an entry or block left empty disappears so absence keeps meaning "same as
 * long-term".
 */
export function writeTermPriceEntry(
  block: ListingHouseTermPricing | undefined,
  term: string,
  field: ListingTermPriceField,
  value: string,
): ListingHouseTermPricing | undefined {
  const all = { ...(block ?? {}) };
  const entry = { ...(all[term] ?? {}) };
  const text = value.replace(/^\$/, "").trim();
  if (text === "") delete entry[field];
  else if (field === "monthlyRent") {
    const n = Number(text.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) entry.monthlyRent = n;
    else delete entry.monthlyRent;
  } else entry[field] = text;
  if (Object.keys(entry).length === 0) delete all[term];
  else all[term] = entry;
  return Object.keys(all).length > 0 ? all : undefined;
}

/** The same write on a room's own `termPricing`. */
export function writeRoomTermPrice(
  room: ManagerRoomSubmission,
  term: string,
  field: ListingTermPriceField,
  value: string,
): ManagerRoomSubmission {
  return { ...room, termPricing: writeTermPriceEntry(room.termPricing, term, field, value) };
}

/**
 * Is this room following the term's Default room on this field?
 *
 * True when the room has no value of its own on the term, or when its value
 * equals the default it is judged against. With no default to judge against, a
 * room that has a value is its own.
 */
export function roomFollowsTermDefault(
  room: ManagerRoomSubmission,
  term: string,
  field: ListingTermPriceField,
  termDefaults: ListingHouseTermPricing | undefined,
): boolean {
  // A term priced per resident is the room's own on that term, as above.
  if (roomHasResidentPricing(room, term)) return false;
  const own = termPriceFieldText(room.termPricing?.[term], field);
  if (own === "") return true;
  const def = termPriceFieldText(termDefaults?.[term], field);
  return def !== "" && own === def;
}

/**
 * Push one field of a term's Default room onto every room still following it.
 *
 * As with {@link applyHouseDefaultsToRooms}, following is judged against the
 * defaults as they were BEFORE the edit, or every room would read as diverged
 * from the new number and freeze. A cleared default drops the field from every
 * following room, so those rooms fall back to long-term.
 */
export function applyHouseTermPricingToRooms(
  rooms: readonly ManagerRoomSubmission[],
  term: string,
  field: ListingTermPriceField,
  next: ListingHouseTermPricing | undefined,
  previous: ListingHouseTermPricing | undefined,
): ManagerRoomSubmission[] {
  const value = termPriceFieldText(next?.[term], field);
  return rooms.map((room) => (roomFollowsTermDefault(room, term, field, previous) ? writeRoomTermPrice(room, term, field, value) : room));
}

/* ─────────────── "Same as Room X": copying one room's description onto another ─────────────── */

/**
 * The fields "Same as Room X" copies (PLAN-0921-1648): everything that
 * describes the room, and nothing about who rents it or what it costs. Rooms
 * no longer have an "All rooms" card to follow — this is a one-time copy, run
 * again by picking a source room, never a standing link. Shared with the
 * Rooms step so the picker's match check and the copy itself read the exact
 * same set of fields.
 */
export type RoomDescriptionField = Extract<
  ListingHouseDefaultField,
  | "floor"
  | "bedsLine"
  | "occupancyCapacity"
  | "furnishing"
  | "roomAmenitiesText"
  | "sizeSqft"
  | "moveInInspectionRequired"
  | "moveOutInspectionRequired"
  | "photoDataUrls"
  | "videoDataUrl"
  | "detail"
  | "moveInInstructions"
  | "moveInPhotoDataUrls"
  | "moveInVideoDataUrl"
>;

export const ROOM_DESCRIPTION_FIELDS: readonly RoomDescriptionField[] = [
  "floor",
  "bedsLine",
  "occupancyCapacity",
  "furnishing",
  "roomAmenitiesText",
  "sizeSqft",
  "moveInInspectionRequired",
  "moveOutInspectionRequired",
  "photoDataUrls",
  "videoDataUrl",
  "detail",
  "moveInInstructions",
  "moveInPhotoDataUrls",
  "moveInVideoDataUrl",
];

function copyRoomDescriptionField(
  source: ManagerRoomSubmission,
  target: ManagerRoomSubmission,
  field: RoomDescriptionField,
): ManagerRoomSubmission {
  switch (field) {
    case "floor":
      return { ...target, floor: source.floor };
    case "bedsLine":
      return { ...target, beds: source.beds, bedCount: source.bedCount };
    case "occupancyCapacity":
      return { ...target, occupancyCapacity: source.occupancyCapacity };
    case "furnishing":
      return { ...target, furnishing: source.furnishing };
    case "roomAmenitiesText":
      return { ...target, roomAmenitiesText: source.roomAmenitiesText };
    case "sizeSqft":
      return { ...target, sizeSqft: source.sizeSqft };
    case "moveInInspectionRequired":
      return { ...target, moveInInspectionRequired: source.moveInInspectionRequired };
    case "moveOutInspectionRequired":
      return { ...target, moveOutInspectionRequired: source.moveOutInspectionRequired };
    case "photoDataUrls":
      return { ...target, photoDataUrls: [...(source.photoDataUrls ?? [])] };
    case "videoDataUrl":
      return { ...target, videoDataUrl: source.videoDataUrl ?? null };
    case "detail":
      return { ...target, detail: source.detail };
    case "moveInInstructions":
      return { ...target, moveInInstructions: source.moveInInstructions };
    case "moveInPhotoDataUrls":
      return { ...target, moveInPhotoDataUrls: [...(source.moveInPhotoDataUrls ?? [])] };
    case "moveInVideoDataUrl":
      return { ...target, moveInVideoDataUrl: source.moveInVideoDataUrl ?? null };
  }
}

/**
 * "Same as Room X": copy every description field from `source` onto `target`,
 * once, right now. Never `id`, `name`, `availability`, `moveInAvailableDate`,
 * `manualUnavailableRanges`, anything about price (`termPricing`, deposit,
 * move-in fee, `rentBasis`, `dailyRentPrice`, `pricingMode` and the rest of
 * the rate card), per-resident pricing (`residentPrices` / `residentPricing` /
 * `moveInResidentDetails`), or `ownRoomFields` itself. Nothing is stored about
 * the pick — it is a plain value copy, so editing the room afterward simply
 * makes it stop matching its source, which is exactly what the picker reads
 * back as "—".
 */
export function copyRoomDescriptionFrom(source: ManagerRoomSubmission, target: ManagerRoomSubmission): ManagerRoomSubmission {
  return ROOM_DESCRIPTION_FIELDS.reduce((acc, field) => copyRoomDescriptionField(source, acc, field), target);
}

/** Do two rooms describe the same room — every {@link ROOM_DESCRIPTION_FIELDS} field equal by value? */
export function roomDescriptionMatches(a: ManagerRoomSubmission, b: ManagerRoomSubmission): boolean {
  return ROOM_DESCRIPTION_FIELDS.every((field) => sameValue(roomDefaultFieldValue(a, field), roomDefaultFieldValue(b, field)));
}

/**
 * The price-card fields "Same as Room X" copies on Pricing. Never name,
 * availability, `rentBasis` / `dailyRentPrice` (those change how rent is
 * billed), fees (`customFees` live on the listing), or per-resident slots.
 */
export const ROOM_PRICING_FIELDS = [
  "monthlyRent",
  "utilitiesEstimate",
  "securityDeposit",
  "pricingMode",
  "prorateMethod",
  "dailyRentRate",
  "dailyUtilitiesRate",
  "weeklyRentPrice",
  "shortTermRent",
  "termPricing",
] as const;

export type RoomPricingField = (typeof ROOM_PRICING_FIELDS)[number];

function moneyText(value: string | number | undefined | null): string {
  if (value == null) return "";
  return String(value).trim();
}

function cloneTermPriceCard(entry: ManagerRoomTermPrice | undefined): ManagerRoomTermPrice | undefined {
  if (!entry) return undefined;
  const next: ManagerRoomTermPrice = {};
  if (entry.monthlyRent != null) next.monthlyRent = entry.monthlyRent;
  if (entry.utilitiesEstimate != null) next.utilitiesEstimate = entry.utilitiesEstimate;
  if (entry.securityDeposit != null) next.securityDeposit = entry.securityDeposit;
  if (entry.pricingMode != null) next.pricingMode = entry.pricingMode;
  if (entry.prorateMethod != null) next.prorateMethod = entry.prorateMethod;
  if (entry.dailyRentRate != null) next.dailyRentRate = entry.dailyRentRate;
  if (entry.dailyUtilitiesRate != null) next.dailyUtilitiesRate = entry.dailyUtilitiesRate;
  return Object.keys(next).length > 0 ? next : undefined;
}

function cloneTermPricingCard(source: ManagerRoomSubmission["termPricing"]): ManagerRoomSubmission["termPricing"] {
  if (!source) return undefined;
  const out: NonNullable<ManagerRoomSubmission["termPricing"]> = {};
  for (const [term, entry] of Object.entries(source)) {
    const cloned = cloneTermPriceCard(entry);
    if (cloned) out[term] = cloned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sameTermPriceCard(a: ManagerRoomTermPrice | undefined, b: ManagerRoomTermPrice | undefined): boolean {
  const left = cloneTermPriceCard(a) ?? {};
  const right = cloneTermPriceCard(b) ?? {};
  return (
    (left.monthlyRent ?? 0) === (right.monthlyRent ?? 0) &&
    moneyText(left.utilitiesEstimate) === moneyText(right.utilitiesEstimate) &&
    moneyText(left.securityDeposit) === moneyText(right.securityDeposit) &&
    (left.pricingMode ?? "") === (right.pricingMode ?? "") &&
    (left.prorateMethod ?? "") === (right.prorateMethod ?? "") &&
    (left.dailyRentRate ?? 0) === (right.dailyRentRate ?? 0) &&
    (left.dailyUtilitiesRate ?? 0) === (right.dailyUtilitiesRate ?? 0)
  );
}

function sameTermPricingCard(a: ManagerRoomSubmission["termPricing"], b: ManagerRoomSubmission["termPricing"]): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const terms = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const term of terms) {
    if (!sameTermPriceCard(left[term], right[term])) return false;
  }
  return true;
}

/** True once a room holds any price-card number — two blank rooms must not match. */
export function roomPricingHasAnyValue(room: ManagerRoomSubmission): boolean {
  return (
    (room.monthlyRent ?? 0) > 0 ||
    moneyText(room.utilitiesEstimate) !== "" ||
    moneyText(room.securityDeposit) !== "" ||
    Boolean(room.pricingMode) ||
    Boolean(room.prorateMethod) ||
    (room.dailyRentRate ?? 0) > 0 ||
    (room.dailyUtilitiesRate ?? 0) > 0 ||
    (room.weeklyRentPrice ?? 0) > 0 ||
    moneyText(room.shortTermRent) !== "" ||
    Object.keys(room.termPricing ?? {}).length > 0
  );
}

/**
 * "Same as Room X" on Pricing: copy this room's price card onto `target`,
 * once, right now. Never `id`, `name`, availability, `rentBasis`,
 * `dailyRentPrice`, per-resident rows, or fees. Nothing is stored about the
 * pick — match is derived every render, same as Rooms.
 */
export function copyRoomPricingFrom(source: ManagerRoomSubmission, target: ManagerRoomSubmission): ManagerRoomSubmission {
  return {
    ...target,
    monthlyRent: source.monthlyRent,
    utilitiesEstimate: source.utilitiesEstimate,
    securityDeposit: source.securityDeposit,
    pricingMode: source.pricingMode,
    prorateMethod: source.prorateMethod,
    dailyRentRate: source.dailyRentRate,
    dailyUtilitiesRate: source.dailyUtilitiesRate,
    weeklyRentPrice: source.weeklyRentPrice,
    shortTermRent: source.shortTermRent,
    termPricing: cloneTermPricingCard(source.termPricing),
  };
}

/** Do two rooms hold the same price card? Two blanks never match. */
export function roomPricingMatches(a: ManagerRoomSubmission, b: ManagerRoomSubmission): boolean {
  if (!roomPricingHasAnyValue(a) || !roomPricingHasAnyValue(b)) return false;
  return (
    (a.monthlyRent ?? 0) === (b.monthlyRent ?? 0) &&
    moneyText(a.utilitiesEstimate) === moneyText(b.utilitiesEstimate) &&
    moneyText(a.securityDeposit) === moneyText(b.securityDeposit) &&
    (a.pricingMode ?? "") === (b.pricingMode ?? "") &&
    (a.prorateMethod ?? "") === (b.prorateMethod ?? "") &&
    (a.dailyRentRate ?? 0) === (b.dailyRentRate ?? 0) &&
    (a.dailyUtilitiesRate ?? 0) === (b.dailyUtilitiesRate ?? 0) &&
    (a.weeklyRentPrice ?? 0) === (b.weeklyRentPrice ?? 0) &&
    moneyText(a.shortTermRent) === moneyText(b.shortTermRent) &&
    sameTermPricingCard(a.termPricing, b.termPricing)
  );
}

/**
 * The per-term Default rooms a submission carries, or, for a term the block
 * does not cover, the most common value the rooms hold on it — so a listing
 * priced room by room before the card existed does not open with an empty
 * card above rooms that plainly have prices.
 */
export function houseTermPricingForSubmission(sub: ManagerListingSubmissionV1): ListingHouseTermPricing | undefined {
  const stored = sub.houseTermPricing;
  let out: ListingHouseTermPricing | undefined = stored ? { ...stored } : undefined;
  const terms = new Set<string>();
  for (const room of sub.rooms ?? []) for (const term of Object.keys(room.termPricing ?? {})) terms.add(term);
  for (const term of terms) {
    if (stored?.[term] && Object.keys(stored[term]).length > 0) continue;
    for (const field of LISTING_TERM_PRICE_FIELDS) {
      const counts = new Map<string, number>();
      for (const room of sub.rooms ?? []) {
        const text = termPriceFieldText(room.termPricing?.[term], field);
        if (text === "") continue;
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      let best: { text: string; n: number } | null = null;
      for (const [text, n] of counts) if (!best || n > best.n) best = { text, n };
      if (best) out = writeTermPriceEntry(out, term, field, best.text);
    }
  }
  return out;
}
