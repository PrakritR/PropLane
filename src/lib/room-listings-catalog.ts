import { getListingRichContent } from "@/data/listing-rich-content";
import type { ListingFloorCard, ListingRoomRow } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  parseMonthlyRent,
  parseUSZip,
  propertyMatchesZipRadius,
} from "@/lib/listings-search";
import { isRoomChoiceAvailable, LISTING_ROOM_CHOICE_SEP, roomBedAvailability } from "@/lib/rental-application/data";
import {
  roomHeadlineAmount,
  roomHeadlinePriceLabel,
  roomIsDailyPriced,
  roomIsWeeklyPriced,
  roomMonthlyEquivalent,
  roomPricePeriod,
  roomPricingIsFlexible,
  roomAdvertisedPriceLabel,
  roomFlexibleSortAmount,
  roomShortLeaseListingNote,
} from "@/lib/room-pricing";

export type RoomListingSlide = {
  roomName: string;
  kind: "photo" | "video";
  src: string;
};

export type RoomListingRow = {
  key: string;
  propertyId: string;
  roomId: string;
  roomName: string;
  floorLabel: string;
  /** e.g. "Second Floor bedroom · University District" */
  title: string;
  /** Short street line, uppercased like marketing cards */
  streetUpper: string;
  neighborhood: string;
  priceLabel: string;
  /** Comparable monthly-equivalent rent used for sorting and budget filters (daily rooms use daily × ~30). */
  rentNumeric: number | null;
  /** The headline number to display: the daily price for daily rooms, the monthly rent otherwise. */
  headlineRent: number | null;
  /** "day" / "week" / "month" — which period priceLabel uses. */
  pricePeriod: "day" | "week" | "month";
  availabilityLabel: string;
  bathroomHint: string;
  zip: string;
  /** Bold title line (street / building line) */
  headlineAddress: string;
  fullAddress: string;
  propertyBeds: number;
  propertyBaths: number;
  petFriendly: boolean;
  descriptionBlurb: string;
  listingTags: readonly string[];
  /** Shown on image overlay, e.g. "$775" or "$750–$875" */
  priceOverlayLabel: string;
  /** Raw listing availability string (for traffic-light styling on search cards). */
  availabilityRaw: string;
  /** Prospect-facing short-lease surcharge note when configured on the room. */
  shortLeaseNote?: string;
  /** Property-wide room media for search card carousel (Room 1, Room 2, … when uploaded). */
  mediaSlides: RoomListingSlide[];
};

function streetUpperFromProperty(p: MockProperty): string {
  const first = p.address.split(",")[0]?.trim() ?? p.address;
  return first.toUpperCase();
}

function headlineAddressFromProperty(p: MockProperty): string {
  return p.address.split(",")[0]?.trim() ?? p.address;
}

function descriptionBlurb(p: MockProperty, room: ListingRoomRow): string {
  const notes = (room.modal.roomNotes ?? room.detail).replace(/\s+/g, " ").trim();
  const extra = notes.length > 80 ? `${notes.slice(0, 80)}…` : notes;
  if (p.tagline && extra) return `${p.tagline} ${extra}`;
  return p.tagline || extra || "Seattle shared home with furnished rooms and common areas.";
}

function listingTags(p: MockProperty): readonly string[] {
  return ["Room rental", p.neighborhood, "Shared living"] as const;
}

function priceOverlayLabelForProperty(p: MockProperty): string {
  const rich = getListingRichContent(p);
  const nums: number[] = [];
  for (const f of rich.floorPlans) {
    for (const r of f.rooms) {
      const n = parseMonthlyRent(r.price.replace("/month", "/ mo"));
      if (n !== null) nums.push(n);
    }
  }
  if (nums.length === 0) return "—";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return `$${min.toLocaleString("en-US")}`;
  return `$${min.toLocaleString("en-US")}–$${max.toLocaleString("en-US")}`;
}

function titleCaseWords(s: string): string {
  return s.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Strip manager bathroom grouping labels like "Bathroom 3 · Second Floor". */
function humanizeFloorLabel(raw: string): string {
  const t = raw.trim();
  if (!t || /other bedrooms|not specified|floor plan/i.test(t)) return "";

  if (t.includes("·")) {
    const parts = t.split("·").map((p) => p.trim()).filter(Boolean);
    const floorPart = parts.find((p) => /floor|level|basement|ground|main|upper|lower|story|stories/i.test(p));
    if (floorPart) return titleCaseWords(floorPart);
    const nonBath = parts.find((p) => !/^bathroom\b/i.test(p));
    if (nonBath) return titleCaseWords(nonBath);
    return "";
  }

  if (/^bathroom\b/i.test(t)) return "";
  return titleCaseWords(t);
}

/** Short, renter-friendly line under the room name on search cards. */
export function formatRoomListingSubtitle(opts: {
  floorLabel: string;
  room: ListingRoomRow;
  neighborhood: string;
}): string {
  const floorFromRoom = opts.room.modal.floorLine?.trim();
  const floor = floorFromRoom ? titleCaseWords(floorFromRoom) : humanizeFloorLabel(opts.floorLabel);
  const neighborhood = opts.neighborhood.trim();

  let lead: string;
  if (floor) {
    lead = /floor|level|basement|ground|story|stories/i.test(floor)
      ? `${floor} bedroom`
      : `${floor} room`;
  } else {
    lead = "Private bedroom";
  }

  if (neighborhood) return `${lead} · ${neighborhood}`;
  return lead;
}

function availabilityLabel(room: ListingRoomRow, roomChoiceValue: string): string {
  const raw = room.availability.trim();
  const a = raw.toLowerCase();
  if (/\bunavailable\b|not available|no longer available/i.test(a)) return raw;
  if (/available\s+after/i.test(raw)) return raw;
  if (/\bwaitlist\b|available soon\b/i.test(a)) return raw;
  if (a.includes("available")) {
    // A single-occupancy room keeps the exact wording it has always had; only a
    // room the manager configured for several residents needs a bed count, and
    // "1 available" would be an outright lie on one that still has two free.
    const { capacity, remaining } = roomBedAvailability(roomChoiceValue);
    if (capacity > 1) {
      return remaining > 0 ? `${remaining} of ${capacity} beds available` : "Fully booked";
    }
    return "1 available";
  }
  return raw;
}

function bathroomHintFromRoom(room: ListingRoomRow): string {
  const accessLines = room.modal.bathroomAccessLines?.filter((line) => line.trim());
  if (accessLines?.length) return accessLines.join(" · ");
  const label = room.modal.bathroomShortLabel?.trim();
  const detail = room.modal.bathroomDetailLine?.trim();
  if (label && detail) return `${label} · ${detail}`;
  if (label) return label;
  const blob = `${room.modal.roomNotes ?? room.detail} ${room.modal.setupLine} ${(room.modal.roomAmenityLabels ?? []).join(" ")}`.toLowerCase();
  const n = room.bathroomShareCount;
  if (typeof n === "number" && n === 1) return "Private bath";
  if (typeof n === "number" && n >= 2) return `${n}-person shared bath`;
  if (/\ben[- ]?suite\b|private bath|private\b/.test(blob)) return "Private bath";
  if (/\bshared\b.*\bbath\b|\bshares bathroom\b/.test(blob)) {
    const m = blob.match(/(\d+)[- ]?person/);
    if (m) return `${m[1]}-person shared bath`;
    return "Shared bath";
  }
  if (blob.includes("hall")) return "Hall bath";
  return "Bath setup on listing";
}

function roomSearchTextBlob(room: ListingRoomRow): string {
  return [
    room.modal.roomNotes ?? room.detail,
    room.modal.setupLine,
    ...room.modal.includedTags,
    ...(room.modal.roomAmenityLabels ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

function roomMatchesBathroomFilterHeuristic(room: ListingRoomRow, bathroomId: string): boolean {
  const blob = roomSearchTextBlob(room);
  if (bathroomId === "private") {
    return /\bprivate\b|en[- ]?suite|en suite\b|private bath/.test(blob);
  }
  // Avoid `\d[- ]?share` — it matches "2 shared" (floor 2 + shared bath).
  if (bathroomId === "2-share") {
    return (
      /\b(?:2|two)[\s\-–]+(?:person|people|resident|roommates)\b/i.test(blob) ||
      /\bshared with\s+(?:one|1)(?:\s+other)?\s+(?:person|people|resident|roommate)s?\b/i.test(blob) ||
      /\b1\s+other\s+(?:person|people|resident|roommate)\b/i.test(blob)
    );
  }
  if (bathroomId === "3-share") {
    return (
      /\b(?:3|three)[\s\-–]+(?:person|people|resident|roommates)\b/i.test(blob) ||
      /\bshared with\s+(?:2|two)(?:\s+other)?\s+(?:person|people|resident|roommate)s?\b/i.test(blob)
    );
  }
  if (bathroomId === "4-share") {
    return (
      /\b(?:4|four)[\s\-–]+(?:person|people|resident|roommates)\b/i.test(blob) ||
      /\bshared with\s+(?:3|three)(?:\s+other)?\s+(?:person|people|resident|roommate)s?\b/i.test(blob)
    );
  }
  return true;
}

/** "any" | "studio" | "1" | "2" | "3" (3 means 3+). */
export function roomMatchesBedroomFilter(propertyBeds: number, bedroomId: string | undefined): boolean {
  if (!bedroomId || bedroomId === "any") return true;
  if (bedroomId === "studio") return propertyBeds === 0;
  if (bedroomId === "3") return propertyBeds >= 3;
  const n = Number.parseInt(bedroomId, 10);
  return Number.isFinite(n) ? propertyBeds === n : true;
}

export function roomMatchesBathroomFilter(room: ListingRoomRow, bathroomId: string): boolean {
  if (bathroomId === "any") return true;

  const n = room.bathroomShareCount;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    if (bathroomId === "private") return n === 1;
    if (bathroomId === "2-share") return n === 2;
    if (bathroomId === "3-share") return n === 3;
    if (bathroomId === "4-share") return n === 4;
    return false;
  }

  return roomMatchesBathroomFilterHeuristic(room, bathroomId);
}

/** Collect room photos/videos across the listing for search-card sliders (Room 1, Room 2, …). */
export function collectPropertyMediaSlides(rich: ReturnType<typeof getListingRichContent>): RoomListingSlide[] {
  const slides: RoomListingSlide[] = [];
  for (const floor of rich.floorPlans) {
    for (const room of floor.rooms) {
      const videoSrc = room.modal.videoSrc?.trim();
      if (videoSrc) slides.push({ roomName: room.name, kind: "video", src: videoSrc });
      for (const url of room.modal.photoUrls ?? []) {
        const src = url.trim();
        if (src) slides.push({ roomName: room.name, kind: "photo", src });
      }
    }
  }
  if (slides.length === 0) {
    for (const url of rich.heroHousePhotoUrls ?? []) {
      const src = url.trim();
      if (src) slides.push({ roomName: "House", kind: "photo", src });
    }
  }
  return slides.slice(0, 12);
}

const BROWSE_ROOM_MODAL_STUB: ListingRoomRow["modal"] = {
  setupLine: "See listing for full room details.",
  tourEyebrow: "Room",
  tourTitle: "Details",
  tourSubtitle: "Open the listing for photos and availability.",
  includedTags: [],
};

/** Ensure every live manager listing yields at least one browsable room row. */
function browseRoomEntries(
  property: MockProperty,
  rich: ReturnType<typeof getListingRichContent>,
): Array<{ floor: ListingFloorCard; room: ListingRoomRow }> {
  const entries: Array<{ floor: ListingFloorCard; room: ListingRoomRow }> = [];
  for (const floor of rich.floorPlans) {
    for (const room of floor.rooms) {
      entries.push({ floor, room });
    }
  }
  if (entries.length > 0) return entries;

  if (property.listingSubmission?.v === 1) {
    const sub = normalizeManagerListingSubmissionV1(property.listingSubmission);
    const submissionRooms = sub.rooms
      // A flexible room is a real, listable room even with no numbers on it —
      // dropping it because `monthlyRent` is 0 would hide the whole sober-living
      // model from browse (PRP-329 acceptance 6).
      .filter((r) => r.name.trim() || r.monthlyRent > 0 || roomPricingIsFlexible(r))
      .map((r, index) => ({
        ...r,
        name: r.name.trim() || `Room ${index + 1}`,
      }));
    if (submissionRooms.length > 0) {
      // "From" uses a flexible room's advertised MINIMUM where it has one, and skips
      // it entirely where it does not — never 0, which would advertise the whole
      // property as free off the back of one unpriced room.
      const rents = submissionRooms
        .map((r) => (roomPricingIsFlexible(r) ? roomFlexibleSortAmount(r) : r.monthlyRent))
        .filter((n): n is number => typeof n === "number" && n > 0);
      const from = rents.length ? Math.min(...rents) : parseMonthlyRent(property.rentLabel) ?? 0;
      const floor: ListingFloorCard = {
        cardKey: `${property.id}-listed-rooms`,
        floorLabel: "Listed rooms",
        fromPrice: from > 0 ? `$${from}` : property.rentLabel || "—",
        roomCount: submissionRooms.length,
        rooms: [],
      };
      for (const r of submissionRooms) {
        const room: ListingRoomRow = {
          id: r.id,
          name: r.name,
          detail: r.utilitiesEstimate?.trim() ? `Utilities · ${r.utilitiesEstimate.trim()}` : "Listed by manager",
          utilitiesEstimate: r.utilitiesEstimate?.trim() || undefined,
          price: roomPricingIsFlexible(r)
            ? roomAdvertisedPriceLabel(r)
            : roomIsDailyPriced(r) || roomIsWeeklyPriced(r)
              ? roomHeadlinePriceLabel(r)
              : r.monthlyRent > 0
                ? `$${r.monthlyRent}/mo`
                : property.rentLabel || "—",
          pricePeriod: roomPricePeriod(r),
          // A flexible room ranks and budget-filters on its advertised minimum, so a
          // prospect searching "under $700" still sees a $600-$900 room they may be
          // able to agree. With no bounds it stays undefined — shown, but never
          // sorted or filtered as if it were free.
          priceMonthlyEquivalent: roomPricingIsFlexible(r)
            ? roomFlexibleSortAmount(r)
            : roomIsDailyPriced(r) || roomIsWeeklyPriced(r)
              ? roomMonthlyEquivalent(r)
              : undefined,
          priceHeadlineAmount: roomPricingIsFlexible(r)
            ? roomFlexibleSortAmount(r)
            : (roomHeadlineAmount(r) ?? undefined),
          shortLeaseNote: roomShortLeaseListingNote(r) ?? undefined,
          availability: "Available now",
          modal: BROWSE_ROOM_MODAL_STUB,
        };
        floor.rooms.push(room);
        entries.push({ floor, room });
      }
      return entries;
    }
  }

  const rent = property.rentLabel?.trim() || "Contact for pricing";
  const floor: ListingFloorCard = {
    cardKey: `${property.id}-property`,
    floorLabel: "Property",
    fromPrice: rent,
    roomCount: 1,
    rooms: [],
  };
  const room: ListingRoomRow = {
    id: "listing",
    name: property.title?.trim() || "Available",
    detail: property.tagline?.trim() || property.neighborhood || "Listed property",
    price: rent,
    availability: "Available now",
    modal: BROWSE_ROOM_MODAL_STUB,
  };
  floor.rooms.push(room);
  entries.push({ floor, room });
  return entries;
}

export function filterRoomListings(
  properties: MockProperty[],
  opts: {
    zipRaw: string;
    radiusMiles: number;
    maxBudgetNum: number | null;
    bathroom: string;
    bedroom?: string;
    petFriendly?: boolean;
    neighborhood?: string;
    moveIn?: string;
    moveOut?: string;
  },
): RoomListingRow[] {
  const centerZip = parseUSZip(opts.zipRaw);
  const hasDateFilter = Boolean(opts.moveIn?.trim() || opts.moveOut?.trim());

  const rows: RoomListingRow[] = [];

  for (const p of properties) {
    const rich = getListingRichContent(p);
    const mediaSlides = collectPropertyMediaSlides(rich);
    const geoOk = centerZip === null ? true : propertyMatchesZipRadius(p.zip, opts.zipRaw, opts.radiusMiles);
    if (!geoOk) continue;
    if (!roomMatchesBedroomFilter(p.beds, opts.bedroom)) continue;
    if (opts.petFriendly && !p.petFriendly) continue;
    if (
      opts.neighborhood &&
      opts.neighborhood !== "any" &&
      p.neighborhood.trim().toLowerCase() !== opts.neighborhood.trim().toLowerCase()
    ) {
      continue;
    }

    for (const { floor, room } of browseRoomEntries(p, rich)) {
      if (
        hasDateFilter &&
        !isRoomChoiceAvailable(`${p.id}${LISTING_ROOM_CHOICE_SEP}${room.id}`, room.availability, {
          leaseStart: opts.moveIn,
          leaseEnd: opts.moveOut,
        })
      ) {
        continue;
      }
      if (!roomMatchesBathroomFilter(room, opts.bathroom)) continue;
      // Daily-priced rooms carry a monthly-equivalent for budget/sort comparisons; their
      // priceLabel already reads "$X/day" so we never parse the daily number as a monthly rent.
      const rentNumeric =
        (room.pricePeriod === "day" || room.pricePeriod === "week") &&
        typeof room.priceMonthlyEquivalent === "number"
          ? room.priceMonthlyEquivalent
          : parseMonthlyRent(room.price.replace("/month", "/ mo"));
      const budgetOk =
        opts.maxBudgetNum === null || !Number.isFinite(opts.maxBudgetNum)
          ? true
          : rentNumeric !== null && rentNumeric <= opts.maxBudgetNum;
      if (!budgetOk) continue;

      rows.push({
        key: `${p.id}:${room.id}`,
        propertyId: p.id,
        roomId: room.id,
        roomName: room.name,
        floorLabel: floor.floorLabel,
        title: formatRoomListingSubtitle({ floorLabel: floor.floorLabel, room, neighborhood: p.neighborhood }),
        streetUpper: streetUpperFromProperty(p),
        neighborhood: p.neighborhood,
        priceLabel: room.price,
        rentNumeric,
        pricePeriod: room.pricePeriod ?? "month",
        // Carried through as an exact number: re-parsing the formatted label would
        // truncate cents (a $39.50/day room would read "$39 / day" on the card).
        headlineRent:
          typeof room.priceHeadlineAmount === "number" && room.priceHeadlineAmount > 0
            ? room.priceHeadlineAmount
            : room.pricePeriod === "day"
              ? parseMonthlyRent(room.price.replace("/day", ""))
              : room.pricePeriod === "week"
                ? parseMonthlyRent(room.price.replace("/week", ""))
              : rentNumeric,
        availabilityLabel: availabilityLabel(room, `${p.id}${LISTING_ROOM_CHOICE_SEP}${room.id}`),
        bathroomHint: bathroomHintFromRoom(room),
        zip: p.zip,
        headlineAddress: headlineAddressFromProperty(p),
        fullAddress: p.address,
        propertyBeds: p.beds,
        propertyBaths: p.baths,
        petFriendly: p.petFriendly,
        descriptionBlurb: [descriptionBlurb(p, room), room.shortLeaseNote].filter(Boolean).join(" · "),
        listingTags: listingTags(p),
        priceOverlayLabel: priceOverlayLabelForProperty(p),
        availabilityRaw: room.availability,
        shortLeaseNote: room.shortLeaseNote,
        mediaSlides,
      });
    }
  }
  return rows;
}

/**
 * Curated Seattle-area house photos used ONLY as a stand-in for the /demo
 * sandbox, which always seeds a real (illustrated) house image per property
 * and should never look "broken" during a demo walkthrough. Production
 * listings with no genuine uploaded photo must NEVER receive one of these —
 * they render `NoImagePlaceholder` instead (see `PropertyBrowseCard.imageUrl`
 * being empty). Do not use this for anything reachable from a real listing.
 */
const DEMO_ONLY_BROWSE_PLACEHOLDER_PHOTOS = [
  "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1613490493576-7fde63acd811?auto=format&fit=crop&w=800&q=80",
  "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=800&q=80",
] as const;

/** Demo-sandbox-only fallback photo — callers must gate this behind `isDemoModeActive()`. */
export function demoOnlyBrowseCardPlaceholderImage(propertyId: string): string {
  let hash = 0;
  for (let i = 0; i < propertyId.length; i++) hash = (hash + propertyId.charCodeAt(i) * (i + 1)) % 9973;
  return DEMO_ONLY_BROWSE_PLACEHOLDER_PHOTOS[hash % DEMO_ONLY_BROWSE_PLACEHOLDER_PHOTOS.length]!;
}

export type PropertyBrowseCard = {
  propertyId: string;
  headlineAddress: string;
  neighborhood: string;
  /** Empty string means no genuine uploaded photo — render `NoImagePlaceholder` (production) or a demo-only fallback (see `demoOnlyBrowseCardPlaceholderImage`). */
  imageUrl: string;
  rentNumeric: number | null;
  /** Headline number to display (daily price for daily rooms, monthly rent otherwise). */
  headlineRent: number | null;
  /** "day" / "week" / "month" — which period the cheapest room is priced by. */
  pricePeriod: "day" | "week" | "month";
  priceLabel: string;
  roomCount: number;
  petFriendly: boolean;
};

export type PropertyBrowseFilters = {
  maxBudgetNum?: number | null;
  bathroom?: string;
  bedroom?: string;
  moveIn?: string;
  moveOut?: string;
  petFriendly?: boolean;
  neighborhood?: string;
  /**
   * Restrict the browse set to exactly these property ids (a shareable "these
   * homes" link — e.g. a manager sending several listings to a prospect). When
   * present, only listings whose id is in the set are considered; the other
   * filters still apply within that set. Empty/undefined means no restriction.
   */
  propertyIds?: string[] | null;
};

export type BrowseSortId = "price-asc" | "price-desc" | "neighborhood";

function aggregateRoomRowsToPropertyCards(roomRows: RoomListingRow[]): PropertyBrowseCard[] {
  const byProperty = new Map<string, PropertyBrowseCard>();

  for (const row of roomRows) {
    const photo = row.mediaSlides.find((s) => s.kind === "photo")?.src?.trim();
    const imageUrl = photo ?? "";
    const existing = byProperty.get(row.propertyId);

    if (!existing) {
      byProperty.set(row.propertyId, {
        propertyId: row.propertyId,
        headlineAddress: row.headlineAddress,
        neighborhood: row.neighborhood,
        imageUrl,
        rentNumeric: row.rentNumeric,
        headlineRent: row.headlineRent,
        pricePeriod: row.pricePeriod,
        priceLabel: row.priceLabel,
        roomCount: 1,
        petFriendly: row.petFriendly,
      });
      continue;
    }

    existing.roomCount += 1;
    // The card shows the cheapest room by monthly-equivalent; carry that room's
    // display number, period, and label together so they never desync.
    if (
      row.rentNumeric !== null &&
      (existing.rentNumeric === null || row.rentNumeric < existing.rentNumeric)
    ) {
      existing.rentNumeric = row.rentNumeric;
      existing.headlineRent = row.headlineRent;
      existing.pricePeriod = row.pricePeriod;
      existing.priceLabel = row.priceLabel;
    }
    if (!existing.imageUrl && imageUrl) existing.imageUrl = imageUrl;
  }

  return [...byProperty.values()];
}

export function sortPropertyBrowseCards(cards: PropertyBrowseCard[], sort: BrowseSortId): PropertyBrowseCard[] {
  const sorted = [...cards];
  sorted.sort((a, b) => {
    if (sort === "neighborhood") {
      const hood = a.neighborhood.localeCompare(b.neighborhood);
      if (hood !== 0) return hood;
      return compareBrowseCardsByPrice(a, b);
    }
    if (sort === "price-desc") return compareBrowseCardsByPrice(b, a);
    return compareBrowseCardsByPrice(a, b);
  });
  return sorted;
}

function compareBrowseCardsByPrice(a: PropertyBrowseCard, b: PropertyBrowseCard): number {
  if (a.rentNumeric === null && b.rentNumeric === null) {
    return a.headlineAddress.localeCompare(b.headlineAddress);
  }
  if (a.rentNumeric === null) return 1;
  if (b.rentNumeric === null) return -1;
  if (a.rentNumeric !== b.rentNumeric) return a.rentNumeric - b.rentNumeric;
  return a.headlineAddress.localeCompare(b.headlineAddress);
}

/** One shopping-style card per property — cheapest available room rent, hero image. */
export function buildPropertyBrowseCards(
  properties: MockProperty[],
  opts?: { filters?: PropertyBrowseFilters; sort?: BrowseSortId },
): PropertyBrowseCard[] {
  const filters = opts?.filters ?? {};
  const idSet =
    filters.propertyIds && filters.propertyIds.length > 0
      ? new Set(filters.propertyIds.map((id) => id.trim()).filter(Boolean))
      : null;
  const scopedProperties = idSet ? properties.filter((p) => idSet.has(p.id)) : properties;
  const roomRows = filterRoomListings(scopedProperties, {
    zipRaw: "",
    radiusMiles: 50,
    maxBudgetNum: filters.maxBudgetNum ?? null,
    bathroom: filters.bathroom ?? "any",
    bedroom: filters.bedroom ?? "any",
    moveIn: filters.moveIn,
    moveOut: filters.moveOut,
    petFriendly: filters.petFriendly,
    neighborhood: filters.neighborhood,
  });

  return sortPropertyBrowseCards(aggregateRoomRowsToPropertyCards(roomRows), opts?.sort ?? "price-asc");
}
