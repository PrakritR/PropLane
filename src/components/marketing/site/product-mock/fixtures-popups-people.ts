/**
 * Fixture data for the home demo's Residents and Vendors pop-ups and record pages
 * (`demo-popups-people.tsx`). Everything is Seattle Homes sample data: no real person, no real address,
 * no photo. Rows are derived from the same fixtures the lists draw (`RESIDENT_ROWS`, `VENDOR_ROWS`,
 * `CATALOG_VENDORS`), so a record and its list row never disagree. Counts a pop-up prints are derived
 * from these rows, never typed beside them.
 */

import {
  CATALOG_VENDORS,
  PROPERTY_ROWS,
  VENDOR_PAYMENTS,
  VENDOR_REVIEWS,
  VENDOR_SERVICES,
  type CatalogVendorFixture,
  type ResidentFixtureRow,
  type VendorDirectoryRow,
} from "@/components/marketing/site/product-mock/fixtures";
import { MANAGER_FORMS } from "@/components/marketing/site/product-mock/fixtures-more";

/* ─────────────────────────────── Add resident wizard ─────────────────────────────── */

export type DemoWizardRoom = { id: string; name: string; monthlyRent: number };

export const DEMO_WIZARD_PROPERTIES: { id: string; label: string }[] = PROPERTY_ROWS.map((p) => ({ id: p.id, label: p.title }));

const rentNumber = (label: string) => Number(label.replace(/[^\d.]/g, "").replace(/\.$/, "")) || 0;

/** A property's rooms as the Home step lists them; a one-room property is rented whole. */
export function demoWizardRooms(propertyId: string): DemoWizardRoom[] {
  const property = PROPERTY_ROWS.find((p) => p.id === propertyId);
  if (!property || property.rooms < 2) return [];
  const base = rentNumber(property.rentLabel);
  return Array.from({ length: property.rooms }, (_, index) => ({
    id: `${property.id}-room-${index + 1}`,
    name: property.title === "Maple Duplex" ? `Unit ${String.fromCharCode(65 + index)}` : `Room ${index + 1}`,
    monthlyRent: base,
  }));
}

/** What the listing prices a placement at (`resolveManualResidentPlacementValues`, fixture-sized). */
export function demoWizardPricing(propertyId: string, roomId: string): { rent: string; utilities: string; moveInFee: string; securityDeposit: string } {
  const room = demoWizardRooms(propertyId).find((r) => r.id === roomId);
  const property = PROPERTY_ROWS.find((p) => p.id === propertyId);
  const rent = room?.monthlyRent ?? (property ? rentNumber(property.rentLabel) : 0);
  return { rent: rent ? String(rent) : "", utilities: rent ? "120" : "", moveInFee: rent ? "150" : "", securityDeposit: rent ? String(rent) : "" };
}

/** The new resident the Add resident pop-up opens with (default fixture values). */
export const DEMO_NEW_RESIDENT = {
  name: "Riley Park",
  email: "riley.park@example.com",
  phone: "(206) 555-0188",
  propertyId: "prop-alder",
  roomId: "prop-alder-room-2",
  moveInDate: "2025-10-01",
  moveOutDate: "2026-09-30",
} as const;

/* ─────────────────────────────── A resident's record ─────────────────────────────── */

export type DemoFactRow = { label: string; value: string; tone?: "ok" | "bad" };
export type DemoFactCardData = { title: string; rows: DemoFactRow[] };

export type DemoResidentRecordData = {
  id: string;
  name: string;
  email: string;
  phone: string;
  stage: ResidentFixtureRow["tab"];
  statusLabel: string;
  property: string;
  unit: string;
  place: string;
  rent: number | null;
  /** `YYYY-MM-DD`. */
  moveInIso: string;
  moveOutIso: string;
  axisId: string;
  /** Potential residents have an application and no tenancy yet. */
  application: DemoFactCardData[];
  backgroundCheck: DemoFactCardData[];
  tours: DemoFactCardData[];
  lease: DemoFactCardData[];
  moveIn: DemoFactCardData[];
  charges: { id: string; title: string; due: string; amount: string; paid: boolean }[];
  services: { id: string; title: string; fact: string }[];
  documents: { id: string; name: string; kind: string }[];
  forms: { id: string; title: string; fact: string }[];
  messages: { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" }[];
};

const isoFromMdy = (mdy: string) => {
  const [m, d, y] = mdy.split("/");
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const mdyFromIso = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const phoneFor = (id: string) => `(206) 555-0${String(100 + ([...id].reduce((s, c) => s + c.charCodeAt(0), 0) % 90)).padStart(3, "0")}`;
const axisFor = (id: string) => `AXIS-${String([...id].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 100000).padStart(5, "0")}`;

export function demoResidentRecord(row: ResidentFixtureRow): DemoResidentRecordData {
  const [unit = "", property = ""] = row.place.split(" · ");
  const propertyRow = PROPERTY_ROWS.find((p) => p.title === property);
  const rent = propertyRow ? rentNumber(propertyRow.rentLabel) : null;
  const moveInIso = isoFromMdy(row.leaseStart);
  const moveOutIso = `${Number(moveInIso.slice(0, 4)) + 1}-${moveInIso.slice(5, 7)}-${moveInIso.slice(8, 10)}`;
  const phone = phoneFor(row.id);
  const first = row.name.split(" ")[0] ?? row.name;
  const potential = row.tab === "potential";
  const past = row.tab === "past";
  const incomplete = row.status === "Incomplete application";
  const signed = row.tab === "current" || past;

  const application: DemoFactCardData[] = [
    { title: "Status", rows: [{ label: "Application", value: incomplete ? "Incomplete" : potential ? "Pending review" : "Approved", tone: potential && !incomplete ? undefined : "ok" }, { label: "Home", value: row.place }] },
    { title: "About them", rows: [{ label: "Full name", value: row.name }, { label: "Email", value: row.email }, { label: "Phone", value: phone }, { label: "Preferred contact", value: "Email" }] },
    { title: "Employment & income", rows: incomplete ? [{ label: "Employer", value: "Not set" }] : [{ label: "Employer", value: "Harbor Coffee Roasters" }, { label: "Monthly income", value: usd(rent ? rent * 3 : 3600) }] },
    { title: "Current address", rows: incomplete ? [{ label: "Street", value: "Not set" }] : [{ label: "Street", value: "418 Pine St, Apt 5" }, { label: "City", value: "Seattle, WA 98101" }] },
    { title: "References & emergency contact", rows: incomplete ? [{ label: "Reference", value: "Not set" }] : [{ label: "Reference", value: "Morgan Ellis · Former landlord" }, { label: "Emergency contact", value: "Sam Park · Parent" }] },
  ];

  const backgroundCheck: DemoFactCardData[] = [
    {
      title: "Background check",
      rows: [
        { label: "Status", value: potential ? (row.status === "Pending review" ? "Awaiting your order" : "Not ordered") : "Passed", tone: potential ? undefined : "ok" },
        { label: "Credit", value: potential ? "Not run" : "Reviewed" },
        { label: "Criminal & eviction", value: potential ? "Not run" : "Clear", tone: potential ? undefined : "ok" },
      ],
    },
  ];

  const tours: DemoFactCardData[] = potential
    ? [{ title: "Tour", rows: [{ label: "When", value: "Sat, Sep 20 · 2:00 PM" }, { label: "Format", value: "In person" }, { label: "Home", value: row.place }, { label: "Status", value: "Completed", tone: "ok" }] }]
    : [{ title: "Tours", rows: [{ label: "Tours", value: "None on file" }] }];

  const lease: DemoFactCardData[] = signed
    ? [
        {
          title: "The lease",
          rows: [
            { label: "Status", value: past ? "Ended" : "Signed by both", tone: past ? undefined : "ok" },
            { label: "Term", value: "12 months" },
            { label: "Move in", value: row.leaseStart },
            { label: "Move out", value: mdyFromIso(moveOutIso) },
            { label: "Monthly rent", value: rent ? usd(rent) : "Not set" },
            { label: "Security deposit", value: rent ? usd(rent) : "Not set" },
          ],
        },
      ]
    : [{ title: "The lease", rows: [{ label: "Status", value: "Not sent yet" }, { label: "Planned move in", value: row.leaseStart }, { label: "Monthly rent", value: rent ? usd(rent) : "Not set" }] }];

  const moveIn: DemoFactCardData[] = [
    {
      title: "Move in",
      rows: [
        { label: "Date", value: row.leaseStart },
        { label: "Keys", value: signed ? "Handed over" : "After the lease is signed" },
        { label: "Inspection", value: signed ? "Completed" : "Not scheduled" },
      ],
    },
  ];

  const months = past ? ["Aug 2024", "Sep 2024"] : signed ? ["Aug 2025", "Sep 2025"] : [];
  const charges = months.map((m, i) => ({
    id: `${row.id}-rent-${i}`,
    title: `Rent · ${m}`,
    due: `Due ${m.split(" ")[0]} 1`,
    amount: rent ? usd(rent) : "$0",
    paid: past || i === 0,
  }));

  const services = row.id === "res-liam" ? [{ id: "svc-faucet", title: "Kitchen faucet drip", fact: "Scheduled · Thu, Sep 25" }] : row.id === "res-maya" ? [{ id: "svc-drain", title: "Slow bathroom drain", fact: "Completed · Sep 15" }] : [];

  const documents = potential
    ? [{ id: `${row.id}-doc-app`, name: `${row.name} application.pdf`, kind: "Application" }]
    : [
        { id: `${row.id}-doc-lease`, name: `${row.name} lease.pdf`, kind: "Lease · signed" },
        { id: `${row.id}-doc-app`, name: `${row.name} application.pdf`, kind: "Application" },
      ];

  const forms = MANAGER_FORMS.filter((f) => f.resident === row.name).map((f) => ({ id: f.id, title: f.title, fact: f.when }));

  const messages: DemoResidentRecordData["messages"] = [
    { id: "m1", author: row.name, body: potential ? `Hi, I just sent my application for ${unit}. Let me know if you need anything else.` : "Hi, do you have the gate code for guests?", at: "Tue 8:41 AM", direction: "inbound" },
    { id: "m2", author: "You", body: potential ? `Thanks ${first}, we are reviewing it now.` : "Gate code is 4471#. Let me know if it works.", at: "Tue 9:05 AM", direction: "outbound" },
  ];

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone,
    stage: row.tab,
    statusLabel: row.status ?? (past ? "Moved out" : signed ? "Current resident" : "Potential resident"),
    property,
    unit,
    place: row.place,
    rent,
    moveInIso,
    moveOutIso,
    axisId: axisFor(row.id),
    application,
    backgroundCheck,
    tours,
    lease,
    moveIn,
    charges,
    services,
    documents,
    forms,
    messages,
  };
}

/** Who gets the "Send setup" and "Remind to finish" messages, and what they say. */
export function demoResidentMessage(kind: "setup" | "remind", row: ResidentFixtureRow): { subject: string; body: string } {
  const first = row.name.split(" ")[0] ?? row.name;
  const home = row.place;
  return kind === "setup"
    ? {
        subject: `Set up your PropLane account for ${home}`,
        body: `Hi ${first},\n\nYour manager added you to ${home}. Create your PropLane account to pay rent, sign documents and message your manager.\n\nhttps://proplane.ai/auth/create-account\n\nSeattle Homes`,
      }
    : {
        subject: "Finish your application",
        body: `Hi ${first},\n\nYour application for ${home} is almost done. You can pick it up where you left off:\n\nhttps://proplane.ai/apply/resume\n\nSeattle Homes`,
      };
}

/** The tenancy-bound options of the small action pop-ups (Add charge, Add service, Add tour, Add document). */
export const DEMO_CHARGE_TYPES = ["Rent", "Utilities", "Security deposit", "Late fee", "Other"] as const;
export const DEMO_SERVICE_CATEGORIES = ["Plumbing", "Electrical", "HVAC", "Appliance repair", "Cleaning", "General maintenance"] as const;
export const DEMO_DOCUMENT_KINDS = ["Application", "Lease · signed", "Lease · draft", "ID · front", "ID · back", "Proof of income", "Other documents"] as const;

/* ─────────────────────────────── Vendors ─────────────────────────────── */

export type DemoVendor = VendorDirectoryRow & { services: number };

export type DemoVendorRecordData = {
  /** Cascade Locksmiths was invited and has not joined: the header reads "Resend invite". */
  invited: boolean;
  overview: DemoFactCardData[];
  services: { id: string; title: string; fact: string; figure?: string }[];
  payments: { id: string; title: string; place: string; fact: string; amount: string }[];
  reviews: { id: string; stars: number; body: string; at: string }[];
  messages: { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" }[];
};

export function demoVendorRecord(vendor: DemoVendor): DemoVendorRecordData {
  const pacific = vendor.id === "vendor-pacific";
  const invited = vendor.id === "vendor-cascade";
  const services = pacific
    ? VENDOR_SERVICES.filter((s) => s.hired).map((s) => ({ id: s.id, title: s.title, fact: `${s.property}${s.unit ? ` · ${s.unit}` : ""} · ${s.fact}`, figure: s.figure }))
    : vendor.services > 0
      ? [{ id: `${vendor.id}-svc`, title: `${vendor.trade} visit`, fact: "Maple Duplex · Scheduled" }]
      : [];
  const payments = pacific ? VENDOR_PAYMENTS.map((p) => ({ id: p.id, title: p.title, place: p.place, fact: `${p.status} · ${p.date}`, amount: p.amount })) : [];
  const reviews = pacific ? VENDOR_REVIEWS.map((r) => ({ id: r.id, stars: r.stars, body: r.body, at: r.at })) : [];
  return {
    invited,
    overview: [
      {
        title: "Contact",
        rows: [
          { label: "Phone", value: vendor.phone },
          { label: "Email", value: vendor.email },
          { label: "Trade", value: vendor.trade },
          { label: "Priority", value: vendor.rank ?? "Standard" },
        ],
      },
      {
        title: "Typical price",
        rows: PROPERTY_ROWS.slice(0, 2).flatMap((p) => [
          { label: p.title, value: `${vendor.trade} · $95/hr · $140 typical service` },
        ]),
      },
    ],
    services,
    payments,
    reviews,
    messages: [
      { id: "vm1", author: "You", body: `Hi ${vendor.name.split(" ")[0]}, are you free Thursday for a ${vendor.trade.toLowerCase()} visit at Alder House?`, at: "Tue 4:12 PM", direction: "outbound" },
      { id: "vm2", author: vendor.name, body: "Yes, I can be there between 10 and noon.", at: "Tue 4:40 PM", direction: "inbound" },
    ],
  };
}

export type DemoCatalogVendorRecordData = {
  overview: DemoFactCardData[];
  pricing: DemoFactCardData[];
  jobs: { id: string; title: string; fact: string }[];
  reviews: { id: string; stars: number; body: string; at: string }[];
  documents: { id: string; name: string; kind: string }[];
};

export function demoCatalogVendorRecord(vendor: CatalogVendorFixture): DemoCatalogVendorRecordData {
  const trades = vendor.trades.split(",").map((t) => t.trim());
  return {
    overview: [
      { title: "Profile", rows: [{ label: "Trades", value: vendor.trades }, { label: "Area", value: vendor.city }, { label: "Insured", value: "Yes", tone: "ok" }, { label: "Licensed", value: "Yes", tone: "ok" }] },
      { title: "Reviews", rows: [{ label: "Rating", value: vendor.rating }] },
    ],
    pricing: [{ title: "Typical price", rows: trades.map((t) => ({ label: t, value: "$110/hr · $180 typical service" })) }],
    jobs: [
      { id: `${vendor.id}-job-1`, title: `${trades[0] ?? "Service"} call`, fact: "Seattle · Completed" },
      { id: `${vendor.id}-job-2`, title: `${trades[0] ?? "Service"} inspection`, fact: "Ballard · Completed" },
    ],
    reviews: [
      { id: `${vendor.id}-rev-1`, stars: 5, body: "On time and clear about the cost before starting.", at: "Sep 12, 2025" },
      { id: `${vendor.id}-rev-2`, stars: 4, body: "Good work, a little late to the window.", at: "Aug 30, 2025" },
    ],
    documents: [
      { id: `${vendor.id}-doc-ins`, name: "Certificate of insurance.pdf", kind: "Insurance" },
      { id: `${vendor.id}-doc-lic`, name: "Business license.pdf", kind: "License" },
    ],
  };
}

export const DEMO_CATALOG_VENDORS = CATALOG_VENDORS;

/** The Rating options on the PropLane vendors filter panel, by floor. */
export const DEMO_RATING_FLOORS: { value: string; label: string }[] = [
  { value: "", label: "Any rating" },
  { value: "3", label: "3+ stars" },
  { value: "4", label: "4+ stars" },
  { value: "4.5", label: "4.5+ stars" },
];

/** A catalog vendor's contact line on the Invite vendor pop-up (the directory holds phone and email). */
export function demoCatalogContact(vendor: CatalogVendorFixture): { trade: string; phone: string; email: string } {
  const slug = vendor.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { trade: vendor.trades.split(",")[0]?.trim() ?? "", phone: phoneFor(vendor.id), email: `office@${slug}.example` };
}

/** `"4.8 (31)"` -> 4.8. */
export const ratingOf = (label: string) => Number(label.split(" ")[0]) || 0;
