/**
 * Sample rows for the demo tabs that the first pass did not draw (Tasks, Bookings, Promotion, Forms,
 * Outgoing payments, Finances, Documents for the manager; Tour and Documents for the resident; Documents and
 * Finances for the vendor). Same sample world as `fixtures.ts`: Seattle Homes' four houses, its residents,
 * Pacific Plumbing and the other vendors, on the demo's Sep 25 calendar. Every count a panel prints is derived
 * from these rows (`docs/agents/marketing-mocks.md`). Labels are copied from the real pages (see each panel).
 */

import { RESIDENT_HOME, VENDOR_NAME } from "@/components/marketing/site/product-mock/fixtures";

/* ── Manager: Tasks ── */

export type TaskFixtureRow = {
  id: string;
  title: string;
  place: string;
  assignee: string;
  /** "Due Oct 12", "Overdue · was due Sep 22", or "Completed Sep 18". */
  when: string;
  overdue?: boolean;
  bucket: "open" | "assigned" | "scheduled" | "completed";
};

export const TASK_ROWS: TaskFixtureRow[] = [
  { id: "task-smoke", title: "Replace smoke detector batteries", place: "Alder House · Room 2", assignee: "No one yet", when: "Overdue · was due Sep 22", overdue: true, bucket: "open" },
  { id: "task-keys", title: "Order spare mailbox keys", place: "Willow Court", assignee: "No one yet", when: "Due Oct 3", bucket: "open" },
  { id: "task-spigots", title: "Winterize outdoor spigots", place: "Maple Duplex", assignee: VENDOR_NAME, when: "Due Oct 15", bucket: "assigned" },
  { id: "task-lock", title: "Re-key Fremont Studio lock", place: "Fremont Studio", assignee: "Cascade Locksmiths", when: "Due Oct 1", bucket: "assigned" },
  { id: "task-carpet", title: "Carpet cleaning before move-in", place: "Willow Court · Room 3", assignee: "Rainier Cleaning", when: "Due Fri, Sep 26, 1:30 PM – 3:30 PM", bucket: "scheduled" },
  { id: "task-gutter", title: "Clear the gutters", place: "Alder House", assignee: "No one yet", when: "Completed Sep 18", bucket: "completed" },
];

/* ── Manager: Bookings ── */

export type BookingFixtureRow = {
  id: string;
  guest: string;
  place: string;
  /** "Oct 3 – Oct 10". */
  stay: string;
  status: "Confirmed" | "In-house" | "Checked out" | "Hold";
  rate: string;
  source?: "Airbnb" | "Booking.com";
  bucket: "upcoming" | "inhouse" | "past";
};

export const BOOKING_ROWS: BookingFixtureRow[] = [
  { id: "bk-1", guest: "Hannah Brooks", place: "Alder House · Room 3", stay: "Oct 3 – Oct 10", status: "Confirmed", rate: "$96/night", source: "Airbnb", bucket: "upcoming" },
  { id: "bk-2", guest: "Hold", place: "Maple Duplex · Unit A", stay: "Oct 8 – Oct 11", status: "Hold", rate: "$118/night", bucket: "upcoming" },
  { id: "bk-3", guest: "Tom Weaver", place: "Alder House · Room 2", stay: "Sep 22 – Sep 28", status: "In-house", rate: "$96/night", source: "Booking.com", bucket: "inhouse" },
  { id: "bk-4", guest: "Elena Cruz", place: "Fremont Studio", stay: "Sep 4 – Sep 9", status: "Checked out", rate: "$142/night", bucket: "past" },
];

/* ── Manager: Promotion ── */

export type PromotionFixtureRow = {
  id: string;
  title: string;
  place: string;
  kind: "Flyer" | "Listing blurb" | "Instagram caption" | "Upload";
  updated: string;
  bucket: "text" | "image";
};

export const PROMOTION_ROWS: PromotionFixtureRow[] = [
  { id: "promo-willow-flyer", title: "Willow Court open house flyer", place: "Willow Court", kind: "Flyer", updated: "Updated Sep 24", bucket: "image" },
  { id: "promo-room3", title: "Room 3 listing blurb", place: "Willow Court", kind: "Listing blurb", updated: "Updated Sep 22", bucket: "text" },
  { id: "promo-fremont", title: "Fremont Studio caption", place: "Fremont Studio", kind: "Instagram caption", updated: "Updated Sep 19", bucket: "text" },
  { id: "promo-alder-photos", title: "Alder House kitchen photo", place: "Alder House", kind: "Upload", updated: "Updated Sep 12", bucket: "image" },
];

/** The channels the "Listing sites" tab counts (its own panel in the real portal, summarised here as rows). */
export const LISTING_SITES = ["Zillow", "Apartments.com", "Facebook Marketplace"] as const;

/* ── Manager: Forms ── */

export type ManagerFormFixture = {
  id: string;
  title: string;
  resident: string;
  place: string;
  blocks: string;
  when: string;
  late?: boolean;
  bucket: "pending" | "completed";
};

export const MANAGER_FORMS: ManagerFormFixture[] = [
  { id: "mform-priya-intake", title: "Intake form", resident: "Tomas Alvarez", place: "Willow Court · Room 2", blocks: "Blocks Move-in details", when: "Due Sep 27", bucket: "pending" },
  { id: "mform-liam-key", title: "Key receipt", resident: "Liam Foster", place: "Alder House · Room 1", blocks: "Blocks nothing", when: "Due Sep 20 · 5 days late", late: true, bucket: "pending" },
  { id: "mform-dana-checklist", title: "Move-in checklist", resident: "Dana Reyes", place: "Maple Duplex · Unit A", blocks: "Blocks nothing", when: "Submitted Sep 24", bucket: "completed" },
  { id: "mform-maya-pet", title: "Pet agreement", resident: "Maya Chen", place: "Maple Duplex · Unit B", blocks: "Blocks Lease signing", when: "Submitted Sep 9", bucket: "completed" },
];

/* ── Manager: Outgoing payments ── */

export type OutgoingFixtureRow = {
  id: string;
  vendor: string;
  detail: string;
  property: string;
  when: string;
  method: "PropLane balance" | "Bank" | "Card or bank account";
  amount: string;
  bucket: "to-pay" | "scheduled" | "paid";
};

export const OUTGOING_ROWS: OutgoingFixtureRow[] = [
  { id: "out-evergreen", vendor: "Evergreen Electric", detail: "Outlet repair", property: "Alder House", when: "Due Sep 29", method: "PropLane balance", amount: "$240.00", bucket: "to-pay" },
  { id: "out-cascade", vendor: "Cascade Locksmiths", detail: "Invoice INV-221", property: "Fremont Studio", when: "Due Oct 2", method: "PropLane balance", amount: "$95.00", bucket: "to-pay" },
  { id: "out-rainier", vendor: "Rainier Cleaning", detail: "Move-out clean", property: "Maple Duplex", when: "Pays Oct 1", method: "Card or bank account", amount: "$180.00", bucket: "scheduled" },
  { id: "out-pacific", vendor: VENDOR_NAME, detail: "Slow bathroom drain", property: "Maple Duplex · Unit B", when: "Paid Sep 15", method: "PropLane balance", amount: "$140.00", bucket: "paid" },
];

/* ── Manager: Documents ── */

export type DocumentFixtureRow = {
  id: string;
  title: string;
  meta: string;
  trailing: string;
  bucket: "applications" | "leases" | "other";
};

export const DOCUMENT_ROWS: DocumentFixtureRow[] = [
  { id: "doc-app-sample", title: "Sample Applicant", meta: "Pending · Maple Duplex · Unit B", trailing: "sample.applicant@example.com", bucket: "applications" },
  { id: "doc-app-alexis", title: "Alexis Cole", meta: "Rejected · Fremont Studio · Studio", trailing: "alexis.cole@example.com", bucket: "applications" },
  { id: "doc-lease-priya", title: "Priya Nair", meta: "Room 1 · Fully Signed", trailing: "Jun 24", bucket: "leases" },
  { id: "doc-lease-luis", title: "Luis Ortega", meta: "Studio · Manager signature pending", trailing: "Sep 23", bucket: "leases" },
  { id: "doc-other-coi", title: "Certificate of insurance.pdf", meta: "Insurance · Portfolio · 214 KB", trailing: "", bucket: "other" },
  { id: "doc-other-tax", title: "2024 property tax statement.pdf", meta: "Tax · Alder House · 98 KB", trailing: "", bucket: "other" },
];

/* ── Manager: Finances ── */

/** Per-property month figures for the Overview's "By property" section, and the strip totals derive from them. */
export const FINANCE_BY_PROPERTY = [
  { id: "fin-alder", title: "Alder House", in: 1650, out: 240 },
  { id: "fin-maple", title: "Maple Duplex", in: 3700, out: 320 },
  { id: "fin-fremont", title: "Fremont Studio", in: 1400, out: 95 },
  { id: "fin-willow", title: "Willow Court", in: 2200, out: 0 },
] as const;

/** The Reports tab: titles only, with the real icon names, in the real order. */
export const FINANCE_REPORTS = [
  "Profit and loss",
  "By property",
  "Ledger (CSV)",
  "Cash flow",
  "Trial balance",
  "Balance sheet",
  "General ledger",
  "Owner statement",
  "Distributions",
] as const;

/* ── Resident: Tour ── */

export type ResidentTourFixture = {
  id: string;
  property: string;
  place: string;
  when: string;
  bucket: "scheduled" | "approved" | "past";
};

export const RESIDENT_TOURS: ResidentTourFixture[] = [
  { id: "rtour-willow", property: RESIDENT_HOME.property, place: `${RESIDENT_HOME.room} · Host Manager`, when: "Thu, Sep 25, 5:30 PM – 6:00 PM", bucket: "approved" },
  { id: "rtour-alder", property: "Alder House", place: "Room 2", when: "Sat, Sep 13, 11:00 AM – 11:30 AM", bucket: "past" },
];

/* ── Resident: Documents ── */

export type ResidentDocumentFixture = {
  id: string;
  title: string;
  meta: string;
  bucket: "to-sign" | "signed" | "payments" | "archived";
};

export const RESIDENT_DOCUMENTS: ResidentDocumentFixture[] = [
  { id: "rdoc-lease-sign", title: "Lease agreement", meta: `${RESIDENT_HOME.property} · Awaiting signature`, bucket: "to-sign" },
  { id: "rdoc-lease-signed", title: "Lease agreement", meta: `${RESIDENT_HOME.property} · Signed ${RESIDENT_HOME.leaseSigned}`, bucket: "signed" },
  { id: "rdoc-receipt", title: "Receipt · October rent", meta: `Oct 1 · ${RESIDENT_HOME.rent}.00`, bucket: "payments" },
  { id: "rdoc-app", title: "Rental application", meta: `${RESIDENT_HOME.property} · Approved`, bucket: "archived" },
];

/* ── Vendor: Documents ── */

export type VendorChecklistItem = {
  id: string;
  title: string;
  section: "Tax" | "Business license" | "Insurance";
  /** The uploaded file's name; absent when nothing has been uploaded. */
  file?: string;
  uploaded?: string;
  required?: boolean;
};

export const VENDOR_CHECKLIST: VendorChecklistItem[] = [
  { id: "vdoc-w9", title: "Signed W-9", section: "Tax", file: "w9-pacific-plumbing.pdf", uploaded: "Uploaded Sep 3, 2025", required: true },
  { id: "vdoc-return", title: "Income tax return", section: "Tax" },
  { id: "vdoc-ein", title: "EIN confirmation letter", section: "Tax", file: "ein-letter.pdf", uploaded: "Uploaded Sep 3, 2025" },
  { id: "vdoc-license", title: "Business / contractor license", section: "Business license", file: "contractor-license.pdf", uploaded: "Uploaded Sep 3, 2025", required: true },
  { id: "vdoc-bond", title: "Surety bond", section: "Business license" },
  { id: "vdoc-coi", title: "Certificate of insurance", section: "Insurance", required: true },
  { id: "vdoc-wc", title: "Workers' compensation certificate", section: "Insurance", file: "workers-comp.pdf", uploaded: "Uploaded Sep 5, 2025" },
];

/* ── Vendor: Finances (Balance & payouts) ── */

export type VendorPayoutFixture = {
  id: string;
  kind: "Standard payout" | "Instant payout";
  bank: string;
  date: string;
  status: "Paid" | "In transit";
  amount: string;
  fee?: string;
};

export const VENDOR_PAYOUTS: VendorPayoutFixture[] = [
  { id: "payout-3", kind: "Standard payout", bank: "Bank ····4821", date: "Sep 17, 2025", status: "Paid", amount: "$140.00" },
  { id: "payout-2", kind: "Instant payout", bank: "Bank ····4821", date: "Sep 2, 2025", status: "Paid", amount: "$95.00", fee: "Fee $1.43" },
  { id: "payout-1", kind: "Standard payout", bank: "Bank ····4821", date: "Aug 30, 2025", status: "Paid", amount: "$310.00" },
];
