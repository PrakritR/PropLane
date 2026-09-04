/** Preset labels stored as lines in `amenitiesText` / `roomAmenitiesText` / shared & bath amenity fields (toggle sync in form). */

/** Whole-property / neighborhood / building — shown only on the final Amenities step. */
export const HOUSE_WIDE_AMENITY_PRESETS = [
  { id: "wifi", label: "WiFi" },
  { id: "in-unit-laundry", label: "In-unit laundry" },
  { id: "in-building-laundry", label: "In-building laundry" },
  { id: "heating", label: "Heating" },
  { id: "ac", label: "Air conditioning" },
  { id: "bike-storage", label: "Bike storage" },
  { id: "ev-charging", label: "EV charging" },
  { id: "elevator", label: "Elevator" },
  { id: "roof-deck", label: "Roof deck / terrace" },
  { id: "yard", label: "Yard / patio" },
  { id: "smart-locks", label: "Smart locks / keyless entry" },
  { id: "security", label: "Controlled building access" },
  { id: "gym", label: "Fitness / gym access" },
  { id: "concierge", label: "Concierge / front desk" },
  { id: "cleaning", label: "Periodic cleaning included" },
  { id: "utilities-included", label: "Some utilities included in rent" },
  { id: "walkable", label: "Walkable neighborhood" },
  { id: "transit", label: "Near public transit" },
  { id: "parking-available", label: "Parking available" },
  { id: "pet-friendly", label: "Pet-friendly building" },
  { id: "package-room", label: "Package room / lockers" },
  { id: "doorman", label: "Doorman" },
  { id: "on-site-mgmt", label: "On-site management" },
  // Commonly-asked amenities that managers were typing by hand (AXI-135).
  // Labels are stored verbatim in `amenitiesText`, so these are additive only —
  // never rename an existing one or saved listings lose the toggle.
  { id: "storage-unit", label: "Storage unit" },
  { id: "garage-parking", label: "Garage parking" },
  { id: "covered-parking", label: "Covered parking" },
  { id: "street-parking", label: "Street parking" },
  { id: "wheelchair-accessible", label: "Wheelchair accessible" },
  { id: "intercom", label: "Intercom / video entry" },
  { id: "security-cameras", label: "Security cameras" },
  { id: "mail-room", label: "Mail room" },
  { id: "trash-included", label: "Trash & recycling included" },
  { id: "pest-control", label: "Pest control included" },
  { id: "lawn-care", label: "Lawn care included" },
  { id: "snow-removal", label: "Snow removal included" },
  { id: "smoke-free", label: "Smoke-free building" },
  { id: "courtyard", label: "Courtyard" },
  { id: "private-balcony", label: "Private balcony" },
  { id: "high-ceilings", label: "High ceilings" },
  { id: "soundproofing", label: "Soundproofing" },
  { id: "near-grocery", label: "Near grocery stores" },
  { id: "near-parks", label: "Near parks" },
  { id: "near-campus", label: "Near campus / university" },
] as const;

/**
 * Kitchen appliances, workspace, and common-area items — use on Shared spaces rows (not the house-wide grid).
 * Labels here are stripped from legacy `amenitiesText` on the public listing so they appear under the right space.
 */
export const SHARED_SPACE_AMENITY_PRESETS = [
  // Kitchen
  { id: "fridge", label: "Refrigerator" },
  { id: "freezer", label: "Freezer" },
  { id: "oven-range", label: "Oven / range" },
  { id: "microwave", label: "Microwave" },
  { id: "dishwasher", label: "Dishwasher" },
  { id: "coffee-station", label: "Coffee station" },
  { id: "toaster-oven", label: "Toaster / toaster oven" },
  { id: "island", label: "Kitchen island" },
  { id: "pantry", label: "Pantry storage" },
  { id: "range-hood", label: "Range hood / vent" },
  { id: "garbage-disposal", label: "Garbage disposal" },
  { id: "bar-stools", label: "Bar / counter seating" },
  // Dining & living
  { id: "dining-table", label: "Dining table & chairs" },
  { id: "sofa", label: "Couch / sofa" },
  { id: "smart-tv", label: "Smart TV" },
  { id: "coffee-table", label: "Coffee table" },
  { id: "hardwood-floors", label: "Hardwood / tile floors" },
  { id: "bookshelf-living", label: "Bookshelves" },
  // Laundry
  { id: "washer-dryer", label: "Washer / dryer" },
  { id: "laundry-sink", label: "Laundry sink" },
  { id: "drying-rack", label: "Drying rack" },
  { id: "iron-board", label: "Iron / ironing board" },
  { id: "detergent-storage", label: "Detergent / supply storage" },
  // Work
  { id: "desk", label: "Desk / workspace" },
  { id: "office-chair", label: "Office chair" },
  { id: "printer", label: "Shared printer" },
  { id: "whiteboard", label: "Whiteboard" },
  { id: "monitor", label: "Monitor / display" },
  { id: "quiet-space", label: "Quiet / sound-dampened" },
  // Outdoor
  { id: "patio-seating", label: "Patio / deck seating" },
  { id: "bbq-grill", label: "BBQ grill" },
  { id: "fire-pit", label: "Fire pit" },
  { id: "yard-lawn", label: "Yard / lawn" },
  { id: "garden", label: "Garden / planters" },
  { id: "shade-umbrella", label: "Umbrella / shade" },
  // Storage & extras
  { id: "storage-locker", label: "Personal storage locker" },
  { id: "bike-storage", label: "Bike storage" },
  { id: "gym-equipment", label: "Gym / exercise equipment" },
  { id: "pool", label: "Pool" },
  { id: "hot-tub", label: "Hot tub / jacuzzi" },
  { id: "pool-table", label: "Pool / billiards table" },
  { id: "parking-spot", label: "Parking spot" },
  { id: "lounge-seating", label: "Living / lounge seating" },
  { id: "tv-common", label: "TV in common area" },
  // AXI-135. Anything added here must also be listed under a kind below, or it
  // only ever appears on a space typed "Other".
  { id: "wine-fridge", label: "Wine fridge" },
  { id: "water-filter", label: "Filtered water" },
  { id: "kettle", label: "Electric kettle" },
  { id: "air-fryer", label: "Air fryer" },
  { id: "blender", label: "Blender" },
  { id: "cookware", label: "Cookware & utensils" },
  { id: "dishes", label: "Dishes & glassware" },
  { id: "trash-bins", label: "Trash & recycling bins" },
  { id: "sound-system", label: "Sound system / speakers" },
  { id: "fireplace", label: "Fireplace" },
  { id: "board-games", label: "Board games" },
  { id: "folding-table", label: "Folding table" },
  { id: "standing-desk", label: "Standing desk" },
  { id: "desk-lamp", label: "Desk lamp" },
  { id: "outdoor-dining", label: "Outdoor dining table" },
  { id: "string-lights", label: "String lights" },
  { id: "garden-hose", label: "Garden hose / spigot" },
  { id: "vacuum", label: "Vacuum & cleaning supplies" },
  { id: "fire-extinguisher", label: "Fire extinguisher" },
  { id: "first-aid", label: "First aid kit" },
  { id: "luggage-storage", label: "Luggage storage" },
] as const;

export type SharedSpaceKind = "kitchen" | "living" | "laundry" | "outdoor" | "workspace" | "other";

export const SHARED_SPACE_KIND_OPTIONS: readonly { id: SharedSpaceKind; label: string }[] = [
  { id: "kitchen", label: "Kitchen & dining" },
  { id: "living", label: "Living / lounge" },
  { id: "laundry", label: "Laundry" },
  { id: "outdoor", label: "Outdoor / yard" },
  { id: "workspace", label: "Workspace" },
  { id: "other", label: "Other (show all amenities)" },
] as const;

const SHARED_SPACE_AMENITY_IDS_BY_KIND: Record<SharedSpaceKind, readonly string[]> = {
  kitchen: [
    "fridge",
    "freezer",
    "oven-range",
    "microwave",
    "dishwasher",
    "coffee-station",
    "toaster-oven",
    "island",
    "pantry",
    "dining-table",
    "range-hood",
    "garbage-disposal",
    "bar-stools",
    "wine-fridge",
    "water-filter",
    "kettle",
    "air-fryer",
    "blender",
    "cookware",
    "dishes",
    "trash-bins",
    "fire-extinguisher",
    "first-aid",
  ],
  living: [
    "dining-table",
    "sofa",
    "smart-tv",
    "coffee-table",
    "lounge-seating",
    "tv-common",
    "pool-table",
    "hardwood-floors",
    "bookshelf-living",
    "sound-system",
    "fireplace",
    "board-games",
    // These two predate AXI-135 and were reachable only on a space typed
    // "Other" — a common area is where they actually live.
    "storage-locker",
    "gym-equipment",
    "luggage-storage",
  ],
  laundry: [
    "washer-dryer",
    "laundry-sink",
    "drying-rack",
    "iron-board",
    "detergent-storage",
    "folding-table",
    "vacuum",
  ],
  outdoor: [
    "patio-seating",
    "bbq-grill",
    "fire-pit",
    "pool",
    "hot-tub",
    "parking-spot",
    "yard-lawn",
    "garden",
    "shade-umbrella",
    "bike-storage",
    "outdoor-dining",
    "string-lights",
    "garden-hose",
  ],
  workspace: [
    "desk",
    "office-chair",
    "printer",
    "whiteboard",
    "monitor",
    "quiet-space",
    "standing-desk",
    "desk-lamp",
  ],
  other: SHARED_SPACE_AMENITY_PRESETS.map((p) => p.id),
};

export function inferSharedSpaceKind(name: string): SharedSpaceKind | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  if (n.includes("kitchen") || n.includes("dining")) return "kitchen";
  if (n.includes("laundry")) return "laundry";
  if (n.includes("outdoor") || n.includes("yard") || n.includes("patio") || n.includes("deck")) return "outdoor";
  if (n.includes("living") || n.includes("lounge")) return "living";
  if (n.includes("office") || n.includes("workspace")) return "workspace";
  return undefined;
}

export function normalizeSharedSpaceKind(raw: unknown, name: string): SharedSpaceKind {
  const allowed = new Set(SHARED_SPACE_KIND_OPTIONS.map((o) => o.id));
  if (typeof raw === "string" && allowed.has(raw as SharedSpaceKind)) return raw as SharedSpaceKind;
  return inferSharedSpaceKind(name) ?? "other";
}

export function sharedSpaceAmenityPresetsForKind(
  kind: SharedSpaceKind | undefined,
  presets: readonly { id: string; label: string }[] = SHARED_SPACE_AMENITY_PRESETS,
): { id: string; label: string }[] {
  const allowed = new Set(SHARED_SPACE_AMENITY_IDS_BY_KIND[kind ?? "other"]);
  return presets.filter((p) => allowed.has(p.id));
}

/** Drop preset amenity lines that don't apply to the selected shared-space type; keep custom lines. */
export function pruneSharedSpaceAmenitiesForKind(
  amenitiesText: string,
  kind: SharedSpaceKind | undefined,
  presets: readonly { id: string; label: string }[] = SHARED_SPACE_AMENITY_PRESETS,
): string {
  const allowedPresets = new Set(sharedSpaceAmenityPresetsForKind(kind, presets).map((p) => p.label));
  const allPresetLabels = new Set(presets.map((p) => p.label));
  return splitLineList(amenitiesText)
    .filter((line) => !allPresetLabels.has(line) || allowedPresets.has(line))
    .join("\n");
}

/** Fixtures & finishes specific to a bathroom row. */
export const BATHROOM_EXTRA_AMENITY_PRESETS = [
  { id: "dual-vanity", label: "Dual vanities" },
  { id: "walk-in-shower", label: "Walk-in / large shower" },
  { id: "soaking-tub", label: "Soaking tub" },
  { id: "heated-floor", label: "Heated floors" },
  { id: "bath-window", label: "Window / natural light" },
  { id: "vent-fan", label: "Exhaust fan" },
  { id: "storage", label: "Built-in storage / linen" },
  // AXI-135. Shower / Toilet / Bathtub stay OUT — they are the fixture
  // checkboxes on the bathroom row, and DISALLOWED_BATHROOM_AMENITY_LABELS
  // rejects them here.
  { id: "bidet", label: "Bidet" },
  { id: "rain-shower", label: "Rain shower head" },
  { id: "handheld-shower", label: "Handheld shower head" },
  { id: "medicine-cabinet", label: "Medicine cabinet" },
  { id: "towel-warmer", label: "Towel warmer / heated rail" },
  { id: "grab-bars", label: "Grab bars / accessible" },
  { id: "vanity-lighting", label: "Vanity lighting" },
  { id: "tiled-shower", label: "Tiled shower" },
  { id: "shower-bench", label: "Shower bench" },
  { id: "double-shower-head", label: "Double shower head" },
] as const;

export const DISALLOWED_BATHROOM_AMENITY_LABELS = new Set([
  "Shower",
  "Toilet",
  "Bathtub",
  "Sink",
  "Mirror",
]);

/** @deprecated Use HOUSE_WIDE_AMENITY_PRESETS — kept as alias for older imports/tests. */
export const LISTING_AMENITY_PRESETS = [
  ...HOUSE_WIDE_AMENITY_PRESETS,
  ...SHARED_SPACE_AMENITY_PRESETS,
] as const;

/** Labels that used to live on the house amenity list and should not duplicate on the main grid when present in legacy `amenitiesText`. */
export const LEGACY_HOUSE_AMENITY_LABELS_IN_SHARED_PRESETS = new Set([
  ...SHARED_SPACE_AMENITY_PRESETS.map((p) => p.label),
  "Desk", // legacy label before "Desk / workspace"
]);

export const ROOM_AMENITY_PRESETS = [
  { id: "heating", label: "Heating" },
  { id: "ac", label: "Air conditioning" },
  { id: "window", label: "Window / natural light" },
  { id: "closet", label: "Closet" },
  { id: "walk-in-closet", label: "Walk-in closet" },
  { id: "blackout", label: "Blackout curtains" },
  { id: "fan", label: "Ceiling fan" },
  { id: "lamp", label: "Lamp / lighting" },
  { id: "outlets", label: "Ample outlets" },
  { id: "usb", label: "USB outlets" },
  { id: "wifi", label: "Wi-Fi" },
  { id: "ethernet", label: "Ethernet / wired internet" },
  { id: "tv", label: "TV" },
  { id: "mini-fridge", label: "Mini fridge" },
  { id: "thermostat", label: "In-room thermostat" },
  { id: "sink", label: "Private sink / vanity" },
  { id: "ensuite", label: "Ensuite bathroom" },
  { id: "balcony", label: "Balcony / bay window" },
  { id: "hardwood", label: "Hardwood floors" },
  { id: "carpet", label: "Carpet" },
  { id: "laminate", label: "Laminate / vinyl flooring" },
  { id: "smoke-detector", label: "Smoke detector" },
  { id: "co-detector", label: "Carbon monoxide detector" },
  { id: "keypad", label: "Keypad lock" },
  // AXI-135.
  { id: "private-entrance", label: "Private entrance" },
  { id: "mirror", label: "Full-length mirror" },
  { id: "blinds", label: "Blinds / shades" },
  { id: "dimmable", label: "Dimmable lighting" },
  { id: "room-safe", label: "In-room safe" },
  { id: "window-ac", label: "Window AC unit" },
  { id: "radiator", label: "Radiator heat" },
  { id: "soundproof-room", label: "Soundproofed walls" },
  { id: "ground-floor", label: "Ground floor" },
  { id: "room-view", label: "Garden / street view" },
] as const;

export const ROOM_FURNITURE_PRESETS = [
  { id: "bed", label: "Bed" },
  { id: "desk", label: "Desk" },
  { id: "chair", label: "Chair" },
  { id: "dresser", label: "Dresser" },
  { id: "wardrobe", label: "Wardrobe" },
  { id: "nightstand", label: "Nightstand" },
  { id: "bookshelf", label: "Bookshelf" },
  { id: "mirror", label: "Mirror" },
] as const;

const FURNITURE_LABEL_BY_LOWER = new Map(
  ROOM_FURNITURE_PRESETS.map((p) => [p.label.toLowerCase(), p.label] as const),
);

export const DISALLOWED_ROOM_AMENITY_LABELS = new Set(["Bed", "Desk", "Private bathroom"]);

export function sanitizeRoomAmenityText(text: string): string {
  return splitLineList(text)
    .filter((line) => !DISALLOWED_ROOM_AMENITY_LABELS.has(line))
    .join("\n");
}

export const ROOM_AVAILABILITY_OPTIONS = [
  "Available now",
  "Available soon",
  "Waitlist",
  "Signed — not available",
  "Unavailable",
] as const;

export const ROOM_FURNISHING_OPTIONS = [
  { value: "", label: "Select" },
  { value: "Unfurnished", label: "Unfurnished" },
  { value: "Bed only", label: "Bed only" },
  { value: "Bed and desk", label: "Bed and desk" },
  { value: "Bed, desk, and chair", label: "Bed, desk, and chair" },
  { value: "Partially furnished", label: "Partially furnished" },
  { value: "Fully furnished", label: "Fully furnished" },
] as const;

/** Known single-value furnishing presets (not ""). */
const FURNISHING_KNOWN: Set<string> = new Set(
  ROOM_FURNISHING_OPTIONS.map((o) => o.value).filter((v) => Boolean(v)) as string[],
);

export function splitLineList(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeToggleLine(existing: string, label: string, on: boolean): string {
  const set = new Set(splitLineList(existing));
  if (on) set.add(label);
  else set.delete(label);
  return [...set].join("\n");
}

/** Toggle an individual furniture item; clears the "Unfurnished" sentinel. */
export function mergeFurnitureToggle(existing: string, label: string, on: boolean): string {
  const normalized = existing
    .replace(/\b(and|&)\b/gi, ",")
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/^(and|&)\s+/i, ""))
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== "unfurnished");
  const set = new Set<string>();
  for (const token of normalized) {
    const canonical = FURNITURE_LABEL_BY_LOWER.get(token.toLowerCase()) ?? token;
    set.add(canonical);
  }
  if (on) set.add(label);
  else set.delete(label);
  return ROOM_FURNITURE_PRESETS.map((p) => p.label)
    .filter((item) => set.has(item))
    .join(", ");
}

/** Case-insensitive: which furniture preset labels are present in the stored string. */
export function parseFurnitureSet(furnishing: string): Set<string> {
  const normalized = furnishing
    .replace(/\b(and|&)\b/gi, ",")
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/^(and|&)\s+/i, ""))
    .filter(Boolean);
  const lower = new Set(normalized.map((l) => l.toLowerCase()));
  const out = new Set<string>();
  for (const p of ROOM_FURNITURE_PRESETS) {
    if (lower.has(p.label.toLowerCase())) out.add(p.label);
  }
  return out;
}

/**
 * A room is Furnished when its `furnishing` string holds real content that isn't the
 * explicit "Unfurnished" marker. This preserves the stored meaning across the
 * Unfurnished→Furnished checkbox inversion: an existing room whose furnishing lists
 * furniture stays Furnished, one stored as "Unfurnished" stays unfurnished, and an
 * empty/new room reads as unfurnished (the new default). The wizard layers session
 * state on top only to keep the box checked for a just-furnished room with no items yet.
 */
export function roomFurnishingIsFurnished(furnishing: string | undefined): boolean {
  const f = (furnishing ?? "").trim();
  return f !== "" && f.toLowerCase() !== "unfurnished";
}

type FurnishingSelectValue = (typeof ROOM_FURNISHING_OPTIONS)[number]["value"];

/** For select: known preset, custom text, or empty */
export function furnishingSelectState(furnishing: string): { select: FurnishingSelectValue; custom: string } {
  const raw = typeof furnishing === "string" ? furnishing : "";
  if (raw.length === 0) return { select: "", custom: "" };
  const t = raw.trim();
  if (FURNISHING_KNOWN.has(t)) return { select: t as FurnishingSelectValue, custom: "" };
  return { select: "", custom: "" };
}

/** Airbnb-style “create listing” basics — property type tiles + dropdown-friendly ids. */
export const LISTING_PROPERTY_TYPE_OPTIONS = [
  { id: "house", label: "House", hint: "Detached or standalone home" },
  { id: "townhouse", label: "Townhouse", hint: "Row or attached home" },
  { id: "apartment", label: "Apartment", hint: "Flat in a building" },
  { id: "condo", label: "Condo", hint: "Owned unit in a building" },
  { id: "duplex", label: "Duplex / triplex", hint: "Small multi-unit building" },
  { id: "other", label: "Other", hint: "Describe in overview" },
] as const;

export const LISTING_PLACE_CATEGORY_OPTIONS = [
  {
    id: "shared_home",
    label: "Shared home — rent by bedroom",
    short: "Shared home",
    hint: "Roommates / coliving — each room listed separately",
  },
  {
    id: "entire_home",
    label: "Entire place — one lease for the home",
    short: "Entire home",
    hint: "Rent the full unit; you can still itemize rooms inside PropLane",
  },
] as const;

export const LISTING_STORIES_OPTIONS = [
  { id: "1", label: "Single level (1 floor)" },
  { id: "2", label: "2 floors" },
  { id: "3", label: "3 floors" },
  { id: "4", label: "4+ floors" },
  { id: "split", label: "Split level" },
] as const;

/**
 * The floor/level picker options are DERIVED from the Home step's Floors count — numbered
 * floors only, no Basement/Loft/Outdoor/Custom. One shared source feeds every floor field
 * (rooms, bathrooms, shared spaces). Split level → Lower/Upper level (chosen for a split
 * home). Floors unset → at least "1st floor" so the dropdown is never empty.
 */
export function floorLevelLabelsFromStories(storiesId: string | undefined): string[] {
  switch (storiesId) {
    case "1":
      return ["1st floor"];
    case "2":
      return ["1st floor", "2nd floor"];
    case "3":
      return ["1st floor", "2nd floor", "3rd floor"];
    case "4":
      return ["1st floor", "2nd floor", "3rd floor", "4th floor or higher"];
    case "split":
      return ["Lower level", "Upper level"];
    default:
      return ["1st floor"];
  }
}

/**
 * Options for a floor/level `<select>`: the derived list plus the current stored value when
 * it is a legacy/out-of-range string (e.g. "Basement / garden level" on an old listing), so
 * existing listings keep and display their value — the picker just stops OFFERING it.
 */
export function floorLevelSelectOptions(storiesId: string | undefined, current: string | undefined): string[] {
  const derived = floorLevelLabelsFromStories(storiesId);
  const cur = (current ?? "").trim();
  return cur && !derived.includes(cur) ? [...derived, cur] : derived;
}

/** Ordinal rank of a numbered floor label ("3rd floor" → 3); null for non-numbered labels. */
export function floorLabelRank(label: string): number | null {
  const m = label.trim().match(/^(\d+)(?:st|nd|rd|th)\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * Clamp a stored floor to the current floor count. A NUMBERED floor beyond the count clamps
 * down to the highest available numbered floor and reports `changed: true` so the UI can
 * show it moved rather than silently corrupting the record. A non-numbered/legacy value is
 * preserved untouched.
 */
export function clampFloorLabelToStories(
  floor: string,
  storiesId: string | undefined,
): { floor: string; changed: boolean } {
  const derived = floorLevelLabelsFromStories(storiesId);
  if (derived.includes(floor)) return { floor, changed: false };
  const rank = floorLabelRank(floor);
  if (rank == null) return { floor, changed: false };
  const topNumbered = [...derived].reverse().find((l) => floorLabelRank(l) != null);
  return topNumbered && topNumbered !== floor ? { floor: topNumbered, changed: true } : { floor, changed: false };
}

export const LISTING_TOTAL_BATH_OPTIONS = [
  { id: "1", label: "1 bathroom" },
  { id: "1.5", label: "1.5 bathrooms" },
  { id: "2", label: "2 bathrooms" },
  { id: "2.5", label: "2.5 bathrooms" },
  { id: "3", label: "3 bathrooms" },
  { id: "3.5", label: "3.5 bathrooms" },
  { id: "4", label: "4 bathrooms" },
  { id: "4+", label: "4+ bathrooms" },
] as const;

export const LISTING_BEDROOM_SLOT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;

/** Sentinel for room floor `<select>` when value is custom text. */
export const ROOM_FLOOR_LEVEL_CUSTOM = "__floor_custom__";

export const LISTING_ROOM_FLOOR_LEVEL_OPTIONS = [
  { id: "basement", label: "Basement / garden level" },
  { id: "main", label: "1st / main floor" },
  { id: "2", label: "2nd floor" },
  { id: "3", label: "3rd floor" },
  { id: "4+", label: "4th floor or higher" },
  { id: "loft", label: "Loft / attic" },
] as const;
