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
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";
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
  moveInInspectionRequired: boolean;
  moveOutInspectionRequired: boolean;
  /** Square footage most rooms share, when they are near enough alike. */
  sizeSqft: number;
  /** How a partial first or last month is split. Never a headline price. */
  prorateMethod: "auto" | "daily_rate" | "";
  /** Whether the advertised price invites an offer. Never changes the figure. */
  pricingMode: "fixed" | "flexible" | "";
};

export type ListingHouseDefaultField = keyof ListingHouseDefaults;

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
  "moveInInspectionRequired",
  "moveOutInspectionRequired",
  "sizeSqft",
  "prorateMethod",
  "pricingMode",
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
    moveInInspectionRequired: false,
    moveOutInspectionRequired: false,
    sizeSqft: 0,
    prorateMethod: "",
    pricingMode: "",
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
  }
}

/** An unset value — treated as inheriting rather than as a deliberate blank. */
function isUnset(value: ListingHouseDefaults[ListingHouseDefaultField]): boolean {
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return value <= 0;
  return false; // a boolean is always a real answer
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
  const roomValue = roomDefaultFieldValue(room, field);
  const defaultValue = defaults[field];
  if (typeof roomValue === "boolean" || typeof defaultValue === "boolean") return roomValue === defaultValue;
  if (isUnset(defaultValue)) return true;
  if (isUnset(roomValue)) return true;
  return roomValue === defaultValue;
}

/** The fields this room has deliberately set differently from the house. */
export function roomOverriddenDefaults(
  room: ManagerRoomSubmission,
  defaults: ListingHouseDefaults,
): ListingHouseDefaultField[] {
  return LISTING_HOUSE_DEFAULT_FIELDS.filter((field) => !roomInheritsDefault(room, defaults, field));
}

/**
 * The rooms that have not been edited at all, and are therefore the only ones a
 * change to the house defaults may move.
 *
 * The rule is per ROOM, not per field. Once a manager has set anything on a
 * room by hand, that room stops following the house for everything — including
 * the fields they left alone. Per-field following looked tidier but meant a
 * manager who had set Room 3's rent still found its beds changing underneath
 * them later. Overwriting an edited room is possible, but only through an
 * explicit "copy to all rooms", never as a side effect of typing.
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
  const stored = (sub as { houseDefaults?: Partial<ListingHouseDefaults> }).houseDefaults;
  const inferred = inferHouseDefaultsFromRooms(sub.rooms ?? []);
  if (!stored) return inferred;
  return { ...inferred, ...stored };
}
