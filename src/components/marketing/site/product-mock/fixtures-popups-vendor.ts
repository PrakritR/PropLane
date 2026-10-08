/**
 * Fixture data for the vendor tabs' pop-ups and record pages (`demo-popups-vendor.tsx`, `panels-vendor.tsx`).
 * Pacific Plumbing, Seattle Homes sample data: no real person, no street address, no tax id, no photo. A
 * vendor who is not hired yet sees the general area only, so a board service carries an area and never an
 * address. Every count a tab prints is derived from these rows, never typed beside them.
 */

import type { PublicBoardServiceView } from "@/lib/public-service-projection";
import type { VendorServiceFixture } from "@/components/marketing/site/product-mock/fixtures";

/* ───────────────────────────── Services ───────────────────────────── */

/**
 * Two more services than the shared fixtures carry, so the Assigned tab and the Completed "Send invoice" action are
 * reachable: an assigned job waiting on the vendor to pick a day, and a finished job whose invoice is still owed.
 */
export const EXTRA_VENDOR_SERVICES: VendorServiceFixture[] = [
  { id: "vsvc-spigot", title: "Replace outdoor spigot", property: "Maple Duplex", unit: "Unit A", hired: true, fact: "Pick a day", factIcon: "clock", figure: "$120", state: "assigned" },
  { id: "vsvc-fan", title: "Replace bathroom exhaust fan", property: "Fremont Studio", hired: true, fact: "No invoice yet", factIcon: "check", figure: "$185", state: "completed" },
];

/** What a job's record page and its Estimate & bid tab need beyond the list row. */
export type VendorJobDetail = {
  trade: string;
  description: string;
  /** "none" = no bid yet; "sent" = a bid waiting on the manager; "visit" = an estimate visit is booked. */
  bid: "none" | "sent" | "visit";
  /** The visit the vendor booked or the manager scheduled, as a short label. */
  visit?: string;
  /** Completed jobs: whether the invoice is still owed, already sent, or paid. */
  invoice?: "owed" | "sent" | "paid";
  budget?: string;
};

export const VENDOR_JOB_DETAILS: Record<string, VendorJobDetail> = {
  "vsvc-willow-faucet": { trade: "Plumbing", description: "Faucet drips when the handle is off.", bid: "none", budget: "Up to $250" },
  "vsvc-hotwater": { trade: "Plumbing", description: "No hot water since Tuesday morning.", bid: "none", budget: "$250 budget" },
  "vsvc-faucet": { trade: "Plumbing", description: "Kitchen faucet drips overnight.", bid: "sent", visit: "Thu, Sep 25 · 10am" },
  "vsvc-drain": { trade: "Plumbing", description: "Bathroom sink drains slowly.", bid: "sent", invoice: "paid" },
  "vsvc-disposal": { trade: "Plumbing", description: "Garbage disposal hums and will not turn.", bid: "sent", invoice: "sent" },
  "vsvc-spigot": { trade: "Plumbing", description: "Outdoor spigot cracked after the cold snap.", bid: "sent" },
  "vsvc-fan": { trade: "General maintenance", description: "Exhaust fan is loud and no longer pulls air.", bid: "sent", invoice: "owed" },
};

export function jobDetailFor(id: string): VendorJobDetail {
  return VENDOR_JOB_DETAILS[id] ?? { trade: "Plumbing", description: "", bid: "sent" };
}

/** Find work: published jobs a vendor can browse. General area only, never an address. */
export const FIND_WORK_BOARD: PublicBoardServiceView[] = [
  { ref: "board-1", title: "Water heater flush", trade: "Plumbing", area: "Capitol Hill", description: "Annual flush and anode check on a 40-gallon tank.", when: "Weekdays", budget: "Up to $180", photos: [], postedBy: "Alder Property Co" },
  { ref: "board-2", title: "Leaking toilet supply line", trade: "Plumbing", area: "Ballard", description: "Slow drip at the shut-off valve.", when: "Anytime", budget: "", photos: [], postedBy: "Northgate Rentals" },
  { ref: "board-3", title: "Replace garbage disposal", trade: "Plumbing", area: "Fremont", description: "Swap a 1/2 hp unit for a new one.", when: "Weekends", budget: "Up to $320", photos: [], postedBy: "Seattle Homes" },
];

/* ───────────────────────────── Calendar ───────────────────────────── */

/** Weekly hours the Set availability dialog opens with: Monday to Friday, 8 AM to 4 PM. */
export type DemoAvailabilityWindow = { weekday: number; startMinute: number; endMinute: number };
export const DEMO_WEEKLY_WINDOWS: DemoAvailabilityWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 16 * 60 }));

/** A date override already on file (open extra time or blocked time off). */
export const DEMO_DATE_OVERRIDES: { id: string; date: string; allDay: boolean; startMinute: number; endMinute: number; kind: "open" | "block"; note: string }[] = [];

/* ───────────────────────────── Finances ───────────────────────────── */

/** Released but not yet withdrawn: what the Withdraw dialog opens with. */
export const DEMO_AVAILABLE_CENTS = 12_500;
export const DEMO_INSTANT_AVAILABLE_CENTS = 12_500;
export const DEMO_BANK = { id: "bank-1", label: "Pacific Plumbing Checking", last4: "4821" };

/** Invoices past their due date, so the Overdue tab has a row to show. */
export const EXTRA_VENDOR_PAYMENTS: { id: string; title: string; place: string; date: string; due: string; status: string; amount: string; manager: string }[] = [
  { id: "vpay-spigot-overdue", title: "INV-1006", place: "Alder House", date: "Aug 12, 2025", due: "Sep 12, 2025", status: "Submitted", amount: "$120.00", manager: "Seattle Homes" },
];

export type DemoRefund = { id: string; paymentLabel: string; manager: string; date: string; status: "pending" | "succeeded" | "failed"; grossCents: number };
export const DEMO_REFUNDS: DemoRefund[] = [
  { id: "refund-2", paymentLabel: "Water heater flush · $95.00", manager: "Seattle Homes", date: "Sep 24", status: "pending", grossCents: 2000 },
  { id: "refund-1", paymentLabel: "Slow bathroom drain · $140.00", manager: "Seattle Homes", date: "Sep 18", status: "succeeded", grossCents: 3500 },
];

/** Paid payments a refund can be started on (gross, fee, and what is already refunded). */
export const DEMO_REFUNDABLE: { id: string; label: string; amountCents: number; platformFeeCents: number; refundedGrossCents: number }[] = [
  { id: "payout-3", label: "Slow bathroom drain · $140.00", amountCents: 14_000, platformFeeCents: 700, refundedGrossCents: 3500 },
  { id: "payout-2", label: "Water heater flush · $95.00", amountCents: 9500, platformFeeCents: 475, refundedGrossCents: 0 },
];

export type DemoStatementLine = { id: string; date: string; type: string; description: string; amountCents: number };
export type DemoStatementMonth = { month: string; lines: DemoStatementLine[]; openingCents: number };

/** Opening balance of each month plus its lines; every closing balance and line count is derived. */
export const DEMO_STATEMENTS: DemoStatementMonth[] = [
  {
    month: "2025-09",
    openingCents: 0,
    lines: [
      { id: "s9-1", date: "Sep 15", type: "Charge", description: "Slow bathroom drain", amountCents: 14_000 },
      { id: "s9-2", date: "Sep 15", type: "PropLane service fee", description: "Slow bathroom drain", amountCents: -700 },
      { id: "s9-3", date: "Sep 17", type: "Withdrawal", description: "Standard payout to Bank ····4821", amountCents: -13_300 },
      { id: "s9-4", date: "Sep 18", type: "Refund", description: "Slow bathroom drain", amountCents: -3500 },
      { id: "s9-5", date: "Sep 18", type: "PropLane service fee", description: "Fee returned on refund", amountCents: 175 },
    ],
  },
  {
    month: "2025-08",
    openingCents: 0,
    lines: [
      { id: "s8-1", date: "Aug 28", type: "Charge", description: "Water heater flush", amountCents: 9500 },
      { id: "s8-2", date: "Aug 28", type: "PropLane service fee", description: "Water heater flush", amountCents: -475 },
      { id: "s8-3", date: "Aug 30", type: "Withdrawal", description: "Standard payout to Bank ····4821", amountCents: -9025 },
    ],
  },
];

export function statementClosingCents(month: DemoStatementMonth): number {
  return month.openingCents + month.lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** Tax: a W-9 on file with a masked id only, and the tax years the earnings fall in. */
export const DEMO_W9 = {
  legalName: "Pacific Plumbing LLC",
  businessName: "Pacific Plumbing",
  entityType: "single_member_llc",
  addressLine1: "100 Example Way",
  addressLine2: "",
  city: "Seattle",
  state: "WA",
  zip: "98101",
  tinType: "ein" as const,
  tinLast4: "0000",
};

export const DEMO_TAX_YEARS: { year: number; earningsCents: number; feesCents: number; refundsCents: number; thresholdCents: number }[] = [
  { year: 2025, earningsCents: 2_450_000, feesCents: 122_500, refundsCents: 3500, thresholdCents: 60_000 },
  { year: 2024, earningsCents: 41_000, feesCents: 2050, refundsCents: 0, thresholdCents: 60_000 },
];

/* ───────────────────────────── Documents ───────────────────────────── */

export type DemoManagerDocument = { id: string; name: string; category: string; date: string };
/** Documents managers shared with the vendor ("From managers"). */
export const DEMO_MANAGER_DOCUMENTS: DemoManagerDocument[] = [
  { id: "mdoc-1", name: "Vendor onboarding packet", category: "Vendor", date: "Sep 3, 2025" },
  { id: "mdoc-2", name: "Building access instructions", category: "Other", date: "Sep 10, 2025" },
];

/* ───────────────────────────── Reviews ───────────────────────────── */

/* ───────────────────────────── service actions ───────────────────────────── */

export type ServiceStageId = "open" | "assigned" | "scheduled" | "completed";
export type VendorServiceActionId = "submit_bid" | "book_visit" | "visit_done" | "decline" | "schedule" | "reschedule" | "mark_done" | "send_invoice" | "message";

export const VENDOR_SERVICE_ACTION_LABELS: Record<VendorServiceActionId, string> = {
  submit_bid: "Submit bid",
  book_visit: "Book visit",
  visit_done: "Visit done",
  decline: "Decline",
  schedule: "Schedule",
  reschedule: "Reschedule",
  mark_done: "Complete",
  send_invoice: "Send invoice",
  message: "Message the manager",
};

/**
 * `vendorServiceActions` (vendor-work-order-tabs.ts): what a vendor can do to a service from its row's or the record
 * header's menu, by stage. Open without a bid: Submit bid, Book visit; with a visit booked: Visit done; Decline while
 * an offer or a bid is waiting. Assigned: Schedule, Message the manager. Scheduled: Reschedule, Complete. Completed:
 * Send invoice while one is owed.
 */
export function demoVendorServiceActions(stage: ServiceStageId, detail: VendorJobDetail, offered: boolean, invoiceOwed: boolean): { id: VendorServiceActionId; label: string }[] {
  const out: VendorServiceActionId[] = [];
  if (stage === "open") {
    if (detail.bid === "none") out.push("submit_bid", "book_visit");
    else if (detail.bid === "visit") out.push("visit_done");
    if (offered || detail.bid === "sent") out.push("decline");
  } else if (stage === "assigned") out.push("schedule", "message");
  else if (stage === "scheduled") out.push("reschedule", "mark_done");
  else if (invoiceOwed) out.push("send_invoice");
  return out.map((id) => ({ id, label: VENDOR_SERVICE_ACTION_LABELS[id] }));
}

/** The bid state a service row stands in: the story's "Quote sent" row is a bid waiting on the manager. */
export function jobBidState(id: string, fact: string): VendorJobDetail["bid"] {
  return /^Quote sent/.test(fact) ? "sent" : jobDetailFor(id).bid;
}
