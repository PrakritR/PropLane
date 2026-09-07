import { listingRichFromManagerSubmission } from "@/data/listing-rich-from-submission";
import { parseMonthlyRent } from "@/lib/listings-search";
import { applyApprovedAvailabilityToRichContent } from "@/lib/rental-application/data";
import type { MockProperty } from "./types";

export type ListingRoomModal = {
  setupLine: string;
  tourEyebrow: string;
  tourTitle: string;
  tourSubtitle: string;
  includedTags: string[];
  /** Manager-provided furnishing summary (shown in room detail modal). */
  furnishingDetail?: string;
  /** Extra labels from room amenities field (beyond includedTags). */
  roomAmenityLabels?: string[];
  /** Uploaded room photos (data URLs or https) — shown in detail modal when present */
  photoUrls?: string[];
  /** Uploaded room video (data URL or https) — replaces placeholder when present */
  videoSrc?: string | null;
  /** Floor / level from manager form (full line in modal). */
  floorLine?: string;
  /** Manager “Room details” textarea — full notes for modal & catalog blurbs. */
  roomNotes?: string;
  /** Short ensuite / shared label for the room modal stat card. */
  bathroomShortLabel?: string;
  /** Secondary bathroom detail under the stat-card label (shared-with names, etc.). */
  bathroomDetailLine?: string;
  /** Numbered access lines, e.g. "Bathroom 1 (shared · 2 rooms)". */
  bathroomAccessLines?: string[];
};

export type ListingRoomRow = {
  id: string;
  name: string;
  /** Short subtitle under the room name in listing tables (not full manager notes). */
  detail: string;
  /** Monthly utilities estimate label from submission (shown in modal). */
  utilitiesEstimate?: string;
  price: string;
  /** "day" / "week" / "month" — which period the headline `price` uses. */
  pricePeriod?: "day" | "week" | "month";
  /** Comparable monthly-equivalent rent used for sorting/budget filters when not priced monthly. */
  priceMonthlyEquivalent?: number;
  /** Prospect-facing short-lease surcharge note, e.g. "+$150/mo on leases ≤3 mo". */
  shortLeaseNote?: string;
  /** Exact headline number behind `price` (daily rate for daily rooms, monthly rent otherwise) — never re-parse `price`. */
  priceHeadlineAmount?: number;
  availability: string;
  modal: ListingRoomModal;
  /**
   * From manager Bathrooms step: rooms assigned to this bathroom row, including this room (`1` = private).
   * Omitted or `null` when baths are not wired in the listing — search uses text heuristics only.
   */
  bathroomShareCount?: number | null;
};

/** Rent + utilities line for floor-plan room cards (browser overlay). */
export function listingRoomPriceMetaLine(room: ListingRoomRow): string | undefined {
  const parts: string[] = [];
  const amount = room.priceHeadlineAmount;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    const formatted = amount % 1 === 0 ? `$${amount.toLocaleString("en-US")}` : `$${amount.toFixed(2)}`;
    parts.push(
      room.pricePeriod === "day"
        ? `${formatted}/day`
        : room.pricePeriod === "week"
          ? `${formatted}/week`
          : `${formatted}/mo`,
    );
  } else {
    const raw = room.price?.trim();
    if (raw && raw !== "—" && raw !== "Included") {
      const numbers = raw.match(/\d+(?:[.,]\d+)*/g);
      if (!numbers || numbers.some((n) => Number.parseFloat(n.replace(/,/g, "")) > 0)) {
        parts.push(raw);
      }
    }
  }
  const utilities = room.utilitiesEstimate?.trim();
  if (utilities) parts.push(utilities);
  const shortLease = room.shortLeaseNote?.trim();
  if (shortLease) parts.push(shortLease);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export type ListingFloorCard = {
  /** Stable React key when cards are built from bathrooms (defaults to floorLabel). */
  cardKey?: string;
  floorLabel: string;
  fromPrice: string;
  roomCount: number;
  remainingNote?: string;
  /** Uploaded floor plan image for this floor group (data URL or https). */
  floorPlanImageUrl?: string;
  rooms: ListingRoomRow[];
};

export type ListingBathroomModal = {
  eyebrow: string;
  setupCard: string;
  /** Bedrooms that use this bathroom — rendered as a list in the detail modal. */
  usedByRoomNames: string[];
  includedTags: string[];
  /** Placeholder “photos” for the gallery strip (no separate video). */
  photoCaptions: string[];
  photoUrls?: string[];
  videoSrc?: string | null;
};

export type ListingBathroomRow = {
  id: string;
  name: string;
  detail: string;
  /** Short “used by” line for browser cards (room names). */
  usedByLabel: string;
  shower: boolean;
  toilet: boolean;
  bathtub: boolean;
  availability: string;
  modal: ListingBathroomModal;
};

export type ListingSharedModal = {
  eyebrow: string;
  tourEyebrow: string;
  tourTitle: string;
  tourSubtitle: string;
  includedTags: string[];
  photoCaptions: string[];
  photoUrls?: string[];
  videoSrc?: string | null;
};

export type ListingSharedRow = {
  id: string;
  name: string;
  detail: string;
  useNote: string;
  availability: string;
  modal: ListingSharedModal;
};

export type LeaseBasicSection = "long-term" | "short-term";

export type ListingPricingBreakdownLine = {
  label: string;
  value: string;
};

export type LeaseBasicRow = {
  id: string;
  icon: string;
  title: string;
  /** Subtitle under title (same role as room “floor” line). */
  detail: string;
  /** Shown in the price column (fee, deposit, “—”, etc.). */
  price: string;
  /** Status / category pill text. */
  status: string;
  body: string;
  /** Groups rows under Long term / Short term headings on the public listing. */
  section?: LeaseBasicSection;
};

export type AmenityItem = { id: string; icon: string; label: string };

export type BundleCard = {
  id: string;
  label: string;
  price: string;
  strikethrough?: string;
  promo?: string;
  /** Short row/subtitle shown on the bundle card. */
  roomsLine: string;
  /** Individual room lines shown as chips/cards instead of one long paragraph. */
  roomLines?: string[];
  /** Small facts shown in the bundle modal/card. */
  summaryItems?: { label: string; value: string }[];
};

export type ListingRichContent = {
  heroTagline: string;
  /** Manager-uploaded general house photos (hero grid + search cards when present). */
  heroHousePhotoUrls?: string[];
  /** Longer house overview from manager submission; shown under the tagline when set. */
  heroOverview?: string;
  /** House rules / community guidelines for the listing (House rules tab). */
  houseRulesBody?: string;
  priceRangeLabel: string;
  /** Lowest base rent from submitted rooms, displayed in the sidebar when totals are not available. */
  startingRentLabel: string;
  /** Lowest rent + utility estimate from submitted rooms, when utilities were entered. */
  estimatedMonthlyTotalLabel?: string;
  /** Deposits, move-in, and signing totals for the pricing sidebar. */
  pricingBreakdown?: ListingPricingBreakdownLine[];
  /** When true, lease basics render explicit Long term / Short term headings. */
  shortTermRentalsAllowed?: boolean;
  /** Section title above room cards (e.g. bathroom grouping vs floor plan). */
  floorPlansSectionTitle?: string;
  floorPlans: ListingFloorCard[];
  bathrooms: ListingBathroomRow[];
  sharedSpaces: ListingSharedRow[];
  leaseBasics: LeaseBasicRow[];
  amenities: AmenityItem[];
  bundlesText: string;
  bundleCards: BundleCard[];
  quickFacts: { label: string; value: string }[];
};

const roomModal = (partial: Partial<ListingRoomModal> & Pick<ListingRoomModal, "setupLine">): ListingRoomModal => ({
  tourEyebrow: "Room tour",
  tourTitle: "Video placeholder",
  tourSubtitle: "Tour coming soon — swap in hosted video when ready.",
  includedTags: ["Bed", "Desk", "Keypad lock", "Heating", "AC"],
  ...partial,
});

const defaultFloors: ListingFloorCard[] = [
  {
    floorLabel: "First floor",
    fromPrice: "$775/month",
    roomCount: 2,
    remainingNote: "2 rooms on this floor",
    rooms: [
      {
        id: "r1",
        name: "Room 1",
        detail: "First floor · Shares bathroom with the second floor as well",
        price: "$775/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Shares bathroom with the second floor as well",
          tourTitle: "Room 1 tour coming soon.",
          tourSubtitle: "Walkthrough placeholder — connect Vimeo, YouTube, or Mux when media is ready.",
          includedTags: ["Bed", "Desk", "Keypad lock", "Heating", "AC", "Shares bathroom with the second floor as well"],
        }),
      },
      {
        id: "r1a",
        name: "Room 1A (flex lease)",
        detail: "First floor · flexible lease lengths",
        price: "$790/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Flex lease: 3-month, 9-month, 12-month, or month-to-month (+$25/mo)",
          tourTitle: "Room 1A tour coming soon.",
          tourSubtitle: "Walkthrough placeholder — connect Vimeo, YouTube, or Mux when media is ready.",
          includedTags: ["Bed", "Desk", "Keypad lock", "Heating", "AC", "Flex lease"],
        }),
      },
    ],
  },
  {
    floorLabel: "Second floor",
    fromPrice: "$800/month",
    roomCount: 4,
    rooms: [
      {
        id: "r2",
        name: "Room 2",
        detail: "Second floor",
        price: "$800/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Second floor · en-suite bath",
          tourTitle: "Room 2 tour coming soon.",
          includedTags: ["Bed", "Closet", "Heating", "AC", "Private bath"],
        }),
      },
      {
        id: "r3",
        name: "Room 3",
        detail: "Second floor",
        price: "$800/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Second floor",
          tourTitle: "Room 3 tour coming soon.",
          includedTags: ["Bed", "Desk", "Heating", "Shared bath"],
        }),
      },
      {
        id: "r4",
        name: "Room 4",
        detail: "Second floor",
        price: "$800/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Second floor · shared bath",
          tourTitle: "Room 4 tour coming soon.",
          includedTags: ["Bed", "Closet", "Heating", "Shared bath"],
        }),
      },
      {
        id: "r5",
        name: "Room 5",
        detail: "Second floor",
        price: "$800/month",
        availability: "Available now",
        modal: roomModal({
          setupLine: "Second floor · shared bath",
          tourTitle: "Room 5 tour coming soon.",
          includedTags: ["Bed", "Desk", "Heating", "Shared bath"],
        }),
      },
    ],
  },
];

const defaultBathrooms: ListingBathroomRow[] = [
  {
    id: "b1",
    name: "Full bath (hall)",
    detail: "Between Room 1 and stairs",
    usedByLabel: "Room 1, Room 2",
    shower: true,
    toilet: true,
    bathtub: true,
    availability: "2 rooms",
    modal: {
      eyebrow: "Bathroom · First floor",
      setupCard: "Tub · single vanity · shared with 1st & 2nd floor",
      usedByRoomNames: ["Room 1", "Room 2"],
      includedTags: ["Shower", "Toilet", "Bathtub", "Vanity", "Exhaust fan"],
      photoCaptions: ["Vanity & mirror", "Tub & shower combo", "Tile detail"],
    },
  },
  {
    id: "b2",
    name: "Three-quarter bath",
    detail: "Second floor landing",
    usedByLabel: "Room 4, Room 5",
    shower: true,
    toilet: true,
    bathtub: false,
    availability: "2 rooms",
    modal: {
      eyebrow: "Bathroom · Second floor",
      setupCard: "Walk-in shower · vanity",
      usedByRoomNames: ["Room 4", "Room 5"],
      includedTags: ["Shower", "Toilet", "Vanity", "Heated floor"],
      photoCaptions: ["Walk-in shower", "Vanity"],
    },
  },
  {
    id: "b3",
    name: "Powder room",
    detail: "Main level by kitchen",
    usedByLabel: "All bedrooms",
    shower: false,
    toilet: true,
    bathtub: false,
    availability: "Common area",
    modal: {
      eyebrow: "Bathroom · Main floor",
      setupCard: "Toilet · sink",
      usedByRoomNames: ["Room 1", "Room 2", "Room 4", "Room 5"],
      includedTags: ["Toilet", "Sink", "Mirror"],
      photoCaptions: ["Powder room overview"],
    },
  },
];

const defaultShared: ListingSharedRow[] = [
  {
    id: "s1",
    name: "Laundry room",
    detail: "Basement · two washers / two dryers",
    useNote: "Card or app payment · detergent shelf",
    availability: "Shared",
    modal: {
      eyebrow: "Shared space",
      tourEyebrow: "Space tour",
      tourTitle: "Laundry tour coming soon.",
      tourSubtitle: "Video placeholder — washers, dryers, and folding counters.",
      includedTags: ["Washers", "Dryers", "Folding counter", "Utility sink", "Storage"],
      photoCaptions: ["Washer wall", "Folding area", "Detergent storage"],
    },
  },
  {
    id: "s2",
    name: "Chef’s kitchen",
    detail: "Main floor · south exposure",
    useNote: "Full appliances · island seating for 6",
    availability: "Shared",
    modal: {
      eyebrow: "Shared space",
      tourEyebrow: "Space tour",
      tourTitle: "Kitchen walkthrough coming soon.",
      tourSubtitle: "Island, appliances, and pantry — drop in your hosted clip.",
      includedTags: ["Gas range", "Dishwasher", "Island", "Pantry", "Coffee station"],
      photoCaptions: ["Island seating", "Appliance wall", "Pantry"],
    },
  },
  {
    id: "s3",
    name: "Living room",
    detail: "Main floor · open to dining",
    useNote: "Sectional · streaming TV · A/C",
    availability: "Shared",
    modal: {
      eyebrow: "Shared space",
      tourEyebrow: "Space tour",
      tourTitle: "Living room tour coming soon.",
      tourSubtitle: "Seating layout and TV nook placeholder.",
      includedTags: ["Sectional", "Smart TV", "Ceiling fan", "Large windows"],
      photoCaptions: ["Seating area", "TV nook", "Windows"],
    },
  },
  {
    id: "s4",
    name: "Dining room",
    detail: "Main floor",
    useNote: "Seats 8 · adjacent to kitchen",
    availability: "Shared",
    modal: {
      eyebrow: "Shared space",
      tourEyebrow: "Space tour",
      tourTitle: "Dining room tour coming soon.",
      tourSubtitle: "Table, lighting, and flow into kitchen.",
      includedTags: ["8-seat table", "Built-in buffet", "Pendant lighting"],
      photoCaptions: ["Table view", "Buffet wall"],
    },
  },
  {
    id: "s5",
    name: "Movie theater",
    detail: "Lower level",
    useNote: "1080p projector · soundbar · tiered seating",
    availability: "Shared",
    modal: {
      eyebrow: "Shared space",
      tourEyebrow: "Space tour",
      tourTitle: "Theater tour coming soon.",
      tourSubtitle: "Seating and screen — ideal for hosted walkthrough video.",
      includedTags: ["Projector", "Soundbar", "Blackout shades", "Tiered seating"],
      photoCaptions: ["Screen wall", "Seating rows", "Snack ledge"],
    },
  },
  {
    id: "s6",
    name: "Back deck + yard",
    detail: "Ground level",
    useNote: "Grill hookups · bike rack nearby",
    availability: "Shared",
    modal: {
      eyebrow: "Outdoor",
      tourEyebrow: "Space tour",
      tourTitle: "Outdoor tour coming soon.",
      tourSubtitle: "Deck, yard, and grill area.",
      includedTags: ["Deck", "Grill gas line", "Bike rack", "Yard lights"],
      photoCaptions: ["Deck overview", "Grill corner", "Yard"],
    },
  },
];

const defaultLease: LeaseBasicRow[] = [
  {
    id: "lease-multi-room",
    section: "long-term",
    icon: "🏘️",
    title: "Two or more rooms",
    detail: "Combine bedrooms on one lease",
    price: "from $1,550/mo",
    status: "Monthly rent",
    body: "Rent two or more rooms on one lease. Starting rates combine the lowest-priced room pair; each additional room adds its listed monthly rent. Utilities are estimated separately.",
  },
  {
    id: "lease-application",
    section: "long-term",
    icon: "📄",
    title: "Application",
    detail: "From listing setup",
    price: "—",
    status: "Due with app",
    body: "Application fee is set in the manager listing form — not shown until that data exists for this property.",
  },
  {
    id: "lease-deposit",
    section: "long-term",
    icon: "🔒",
    title: "Security deposit",
    detail: "From listing setup",
    price: "—",
    status: "At signing",
    body: "Security deposit amount comes from the published listing. Confirm in your lease and with the property manager.",
  },
  {
    id: "lease-movein",
    section: "long-term",
    icon: "🧾",
    title: "Move-in charges",
    detail: "From listing setup",
    price: "—",
    status: "At signing",
    body: "Move-in charges are configured by the property manager on the listing. See the final lease for what they cover.",
  },
];

const defaultAmenities: AmenityItem[] = [
  { id: "amen-walk", icon: "🚶", label: "Walkable location" },
  { id: "amen-clean", icon: "🧹", label: "Bi-monthly cleaning (twice a month)" },
  { id: "amen-ac-lr", icon: "❄️", label: "A/C in living room only" },
  { id: "amen-fridge", icon: "🧊", label: "Refrigerator" },
  { id: "amen-stove", icon: "🔥", label: "Stove" },
  { id: "amen-laundry", icon: "🧺", label: "In-unit laundry (washer & dryer)" },
  { id: "amen-wifi", icon: "📶", label: "WiFi" },
  { id: "amen-transit", icon: "🚌", label: "Public transportation" },
  { id: "amen-micro", icon: "📦", label: "Microwave" },
  { id: "amen-oven", icon: "🍳", label: "Oven" },
  { id: "amen-desk", icon: "🪑", label: "Desk" },
  { id: "amen-bed", icon: "🛏️", label: "Bed" },
  { id: "amen-heat", icon: "🌡️", label: "Heating" },
  { id: "amen-ac", icon: "🎛️", label: "AC" },
  { id: "amen-dish", icon: "🍽️", label: "Dishwasher" },
  { id: "amen-disposal", icon: "♻️", label: "Garbage disposal" },
  { id: "amen-eq", icon: "🏋️", label: "Fitness center / gym access" },
  { id: "amen-pool", icon: "🏊", label: "Pool / spa" },
  { id: "amen-roof", icon: "🌇", label: "Rooftop / terrace" },
  { id: "amen-pet", icon: "🐕", label: "Pet washing station" },
  { id: "amen-package", icon: "📬", label: "Package lockers" },
  { id: "amen-bike", icon: "🚲", label: "Bike storage" },
  { id: "amen-ev", icon: "🔌", label: "EV charging" },
  { id: "amen-elev", icon: "🛗", label: "Elevator" },
  { id: "amen-security", icon: "🔒", label: "Controlled access / smart locks" },
  { id: "amen-smoke", icon: "💨", label: "Smoke-free building" },
];

/** Shown when the listing uses generated demo content (no manager submission). */
export const DEFAULT_LISTING_HOUSE_RULES_FALLBACK =
  "Quiet hours typically 10pm–8am; confirm with the property manager. No smoking indoors unless posted otherwise. Guests and overnight visitors may require notice — ask before your tour. Shared spaces stay tidy; label food in shared refrigerators.";

const defaultBundles: BundleCard[] = [
  {
    id: "bundle-multi-room",
    label: "Two or more rooms",
    price: "from $1,550/mo",
    promo: "Combine any bedrooms on one lease",
    roomsLine: "5 rooms available — rent 2 or more together",
    roomLines: ["Room 1: $875", "Room 2: $800", "Room 3: $775", "Room 4: $775"],
    summaryItems: [
      { label: "Rooms", value: "5" },
      { label: "2-room start", value: "$1,550/mo" },
      { label: "Rent range", value: "$775–$875/mo" },
    ],
  },
];

export function getListingRichContent(property: MockProperty): ListingRichContent {
  if (property.listingSubmission?.v === 1) {
    try {
      const rich = applyApprovedAvailabilityToRichContent(
        property,
        listingRichFromManagerSubmission(property, property.listingSubmission),
      );
      return rich;
    } catch {
      /* Corrupt or partial submission in localStorage — fall back to generic layout. */
    }
  }
  // A listing with no rent yet (an unfinished draft) has no price to show. The
  // fabricated band below used to run anyway: mid=0 gave `low = max(500, -125)`
  // and `high = 100`, printing the range BACKWARDS as "from $500–$100/mo"
  // (F-DRAFT-2). No rent → no price label, never an invented one.
  //
  // The $500 floor is clamped to the rent itself for the same reason the range
  // is ordered: it must never contradict the price printed beside it. Unclamped,
  // a $450/mo listing rendered "$450/mo" as its starting rent directly above a
  // band reading "from $500–$550/mo" — two different prices for one unit, which
  // is the defect this finding is about, just one screen over.
  const parsedRent = parseMonthlyRent(property.rentLabel);
  const mid = parsedRent === null ? 875 : parsedRent;
  const hasRent = mid > 0;
  const low = Math.min(Math.max(Math.min(500, mid), mid - 125), mid);
  const high = Math.max(mid + 100, low);
  return {
    heroTagline: property.tagline,
    houseRulesBody: DEFAULT_LISTING_HOUSE_RULES_FALLBACK,
    priceRangeLabel: hasRent ? `from $${low}–$${high}/mo` : "—",
    startingRentLabel: hasRent ? `$${mid}/mo` : "—",
    floorPlans: defaultFloors,
    bathrooms: defaultBathrooms,
    sharedSpaces: defaultShared,
    leaseBasics: defaultLease,
    amenities: defaultAmenities,
    bundlesText:
      "**Four lease options** are available for every package. Month-to-month renewals add **$25/month** where applicable.",
    bundleCards: defaultBundles,
    quickFacts: [
      { label: "Rooms listed", value: String(Math.max(property.beds * 3, 3)) },
      { label: "Bathrooms", value: String(property.baths + 1.5) },
      { label: "Type", value: "Shared housing" },
      { label: "Pets", value: "Ask manager" },
    ],
  };
}
