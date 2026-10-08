/**
 * Fixture data for the resident side of the home demo's pop-ups and record views (`demo-popups-resident.tsx`).
 * Everything here is Seattle Homes sample data for Jordan (Willow Court, Room 3): no real person, no real
 * address, no photo. Counts a pop-up prints are derived from these rows, never typed beside them.
 */

import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";
import { normalizeHouseInfo } from "@/lib/house-info";
import type { ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";
import type { PropertySearchOption } from "@/components/marketing/property-search-picker";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PROPERTY_ROWS, RESIDENT_HOME } from "@/components/marketing/site/product-mock/fixtures";

/** Jordan's contact details, as the tour and application forms hold them. */
export const RESIDENT_CONTACT = {
  name: "Jordan Rivera",
  email: "jordan.rivera@example.com",
  phone: "(206) 555-0114",
};

export const PROPERTY_MANAGER = { name: "Seattle Homes", workPhone: "(206) 555-0100", email: "manager@seattlehomes.example" };

/* ───────────────────────────── My home ───────────────────────────── */

/** The structured house details the manager filled in (`HouseInfoReadSections` draws every section from this). */
export const DEMO_HOUSE_INFO = normalizeHouseInfo({
  access: {
    doorCode: "4471#",
    gateCode: "None",
    keyPickup: "Key in the front desk drawer",
    parking: "Street parking on Willow Court",
  },
  wifi: { network: "WillowCourt", password: "shared-at-move-in" },
  trash: { day: "Tuesday", binLocation: "Side of the house, behind the gate", cleaningCadence: "Weekly" },
  rules: {
    quietFrom: "22:00",
    quietTo: "07:00",
    smoking: "No smoking, vaping or cannabis anywhere",
    guests: "Ask the manager first",
    pets: "Case by case",
  },
  contacts: { emergency: "(206) 555-0142", onSite: "Seattle Homes office, weekdays 9 to 5" },
  laundry: { location: "Basement, coin-free", hours: "8am - 10pm" },
  safety: { shutoffs: "Breaker panel in the hall closet", extinguisher: "Under the kitchen sink" },
});

/** What `loadResidentMoveInForEmail` hands the real Move-in details tabs. */
export const DEMO_MOVE_IN_RESOLVED: ResidentMoveInResolved = {
  propertyLabel: RESIDENT_HOME.property,
  addressLine: RESIDENT_HOME.address,
  roomId: "room-3",
  roomLabel: RESIDENT_HOME.room,
  earliestMoveInDateLabel: RESIDENT_HOME.moveIn,
  instructions: "Your room is at the top of the stairs, second door on the right. The key on the blue tag opens it.",
  moveInPhotoDataUrls: [],
  moveInVideoDataUrl: null,
  houseInstructions: "The front door sticks: lift the handle and push. The package shelf is in the hall by the coats.",
  houseMoveInPhotoDataUrls: [],
  houseMoveInVideoDataUrl: null,
  houseInfo: DEMO_HOUSE_INFO,
  generalHouseInfo: null,
  houseRulesText: null,
  amenities: ["In-unit laundry", "Fenced yard", "Bike storage"],
  wifiNetworkName: null,
  wifiPassword: null,
  housemates: [
    { id: "hm-tomas", name: "Tomas Alvarez", email: "", roomLabel: "Room 2", phone: "(206) 555-0148", isRoommate: false },
    { id: "hm-priya", name: "Priya Shah", email: "", roomLabel: "Room 1", phone: null, isRoommate: false },
  ],
  residentSection: null,
};

/** The Inspections tab starts empty: the move-in inspection has not been photographed yet. */
export const DEMO_INSPECTION_STATUS_OPTIONS = ["all", "upcoming", "in-progress", "done"] as const;

/* ───────────────────────────── Forms ───────────────────────────── */

function q(key: string, label: string, type: MoveInFormQuestion["type"], required: boolean, section?: string, options: string[] = []): MoveInFormQuestion {
  return { id: `rq-${key}`, key, label, type, required, options, ...(section ? { section } : {}) };
}

/** The questions each of Jordan's forms asks, one per screen, and what he answered on a completed one. */
export const RESIDENT_FORM_QUESTIONS: Record<string, { questions: MoveInFormQuestion[]; answers?: Record<string, string> }> = {
  "form-movein": {
    questions: [
      q("arrival", "When do you plan to arrive?", "date", true, "Move-in"),
      q("phone", "Best phone number", "phone", true, "Move-in"),
      q("vehicle", "Will you bring a vehicle?", "yes_no", true, "Move-in"),
      q("notes", "Anything we should know before you arrive?", "long_text", false, "Move-in"),
      q("signature", "Signature", "signature", true, "Sign-off"),
    ],
  },
  "form-insurance": {
    questions: [
      q("carrier", "Insurance company", "text", true, "Renters insurance"),
      q("policy", "Policy number", "text", true, "Renters insurance"),
      q("signature", "Signature", "signature", true, "Sign-off"),
    ],
  },
  "form-rules": {
    questions: [
      q("read", "I have read the house rules", "yes_no", true, "House rules"),
      q("signature", "Signature", "signature", true, "House rules"),
    ],
    answers: { read: "Yes", signature: "Jordan Rivera" },
  },
};

/* ───────────────────────────── Services ───────────────────────────── */

/** What each fixture service record shows beyond its list row (the maintenance request shape). */
export const DEMO_SERVICE_DETAIL = {
  priority: "Medium",
  preferredArrival: "Anytime",
  entry: "Call first",
  description: "The kitchen faucet drips all night and the cold handle is loose.",
  vendor: "Pacific Plumbing",
  vendorAssigned: "Sep 25, 2025",
};

/* ───────────────────────────── Tours ───────────────────────────── */

/** The homes the "Choose a home to tour" and "Apply to a property" pickers list. */
export const DEMO_HOME_OPTIONS: PropertySearchOption[] = PROPERTY_ROWS.map((p) => ({
  id: p.id,
  title: p.title,
  subtitle: `${p.street}, Seattle`,
  tags: [p.neighborhood, p.rentLabel],
  searchText: `${p.title} ${p.street} ${p.neighborhood}`,
}));

/** The rooms a home lists (Step 1 of the tour flow), rent from the home's row. */
export function demoRoomsFor(propertyId: string): PropertySearchOption[] {
  const row = PROPERTY_ROWS.find((p) => p.id === propertyId) ?? PROPERTY_ROWS[0]!;
  return Array.from({ length: row.rooms }, (_, i) => ({
    id: `${row.id}::room-${i + 1}`,
    title: `Room ${i + 1} · ${i === 0 ? "1st" : "2nd"} floor · ${row.rentLabel.replace("/mo", "")}/mo`,
    subtitle: row.title,
    tags: [row.street, row.neighborhood, "Available now"],
    searchText: `Room ${i + 1} ${row.street} ${row.neighborhood} ${row.rentLabel}`,
  }));
}

/** Tour windows the host published: 30-minute slots, weekdays. */
export const DEMO_TOUR_SLOTS = ["10:00 AM", "10:30 AM", "11:00 AM", "1:00 PM", "1:30 PM", "2:00 PM", "3:30 PM", "4:00 PM"];

export const DEMO_TOUR_UPDATES = [
  "Your property manager reviews the requested time.",
  "You receive a confirmation email and inbox message once the tour is approved.",
  "Check Communication for replies from your property team.",
];

/* ───────────────────────────── Payments ───────────────────────────── */

export const DEMO_PAYMENT_METHODS = [
  { id: "card", label: "Card", sub: "Visa ending 4242" },
  { id: "ach", label: "Bank account", sub: "Checking ending 6789" },
];

export const DEMO_AUTOPAY_CARD = { method: "Checking ending 6789", nextPayment: "Rent · $1,080.00 on Nov 1" };

/* ───────────────────────────── Documents ───────────────────────────── */

export type ResidentDocKind = "application" | "lease" | "receipts" | "other";

/** Jordan's own upload, in Archived beside the approved application. */
export const DEMO_OTHER_DOCUMENT = { id: "rdoc-insurance", title: "Renter's insurance policy", meta: "Uploaded Sep 26 · PDF", bucket: "archived" as const };

export const DEMO_RECEIPT = { date: "Oct 1, 2025", amount: `${RESIDENT_HOME.rent}.00`, title: "October rent", method: "Card ending 4242", reference: "RCPT-1001" };

/* ───────────────────────────── Communication ───────────────────────────── */

export const DEMO_COMPOSE_CONTACTS: InboxScopedContact[] = [
  {
    id: "mgr-demo",
    name: PROPERTY_MANAGER.name,
    email: PROPERTY_MANAGER.email,
    role: "manager",
    propertyLabel: RESIDENT_HOME.property,
  },
];
