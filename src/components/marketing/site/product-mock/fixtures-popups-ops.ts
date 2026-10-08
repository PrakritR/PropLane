/**
 * Fixture data for the home demo's operations pop-ups and record views (`demo-popups-ops.tsx`): Tasks, Bookings,
 * Promotion, Outgoing payments, Finances and Documents. Same Seattle Homes sample world as `fixtures.ts` /
 * `fixtures-more.ts` (the rows themselves live there; this file adds what a record page or a pop-up shows beyond a
 * list row). No real person, no real address, no photo. Counts a panel prints are derived from rows, never typed.
 */

import { VENDOR_NAME } from "@/components/marketing/site/product-mock/fixtures";

/* ───────────────────────────── shared ───────────────────────────── */

export type OpsMessage = { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" };

/** The houses the pickers offer (the same four the Properties tab draws), with their rooms. */
export const OPS_HOUSES: { id: string; label: string; rooms: string[] }[] = [
  { id: "prop-alder", label: "Alder House", rooms: ["Room 1", "Room 2", "Room 3"] },
  { id: "prop-maple", label: "Maple Duplex", rooms: ["Unit A", "Unit B", "Unit C", "Unit D"] },
  { id: "prop-fremont", label: "Fremont Studio", rooms: [] },
  { id: "prop-willow", label: "Willow Court", rooms: ["Room 1", "Room 2", "Room 3"] },
];

/** The residents the pickers offer: name, house and room. */
export const OPS_RESIDENTS: { id: string; name: string; email: string; houseId: string; room: string }[] = [
  { id: "res-liam", name: "Liam Foster", email: "liam.foster@example.com", houseId: "prop-alder", room: "Room 1" },
  { id: "res-tom", name: "Tom Weaver", email: "tom.weaver@example.com", houseId: "prop-alder", room: "Room 2" },
  { id: "res-dana", name: "Dana Reyes", email: "dana.reyes@example.com", houseId: "prop-maple", room: "Unit A" },
  { id: "res-maya", name: "Maya Chen", email: "maya.chen@example.com", houseId: "prop-maple", room: "Unit B" },
  { id: "res-tomas", name: "Tomas Alvarez", email: "tomas.alvarez@example.com", houseId: "prop-willow", room: "Room 2" },
];

/** The people a task or a payment can be assigned to: the team and the vendors. */
export const OPS_ASSIGNEES: { value: string; label: string }[] = [
  { value: "none", label: "No one yet" },
  { value: "me", label: "Me" },
  { value: "vendor-pacific", label: VENDOR_NAME },
  { value: "vendor-cascade", label: "Cascade Locksmiths" },
  { value: "vendor-rainier", label: "Rainier Cleaning" },
];

/* ───────────────────────────── Tasks ───────────────────────────── */

export type OpsTaskDetail = {
  kind: "general" | "move-in" | "move-out" | "tour" | "service";
  description: string;
  houseId: string;
  room: string;
  residentId: string;
  assignee: string;
  scheduleDate: string;
  startTime: string;
  endTime: string;
  timing: "scheduled" | "urgent" | "deadline";
  priority: "high" | "medium" | "low";
  dueDate: string;
  notes: string;
  checklist: string;
  attachments: string;
  status: string;
  created: string;
  linked: { id: string; title: string; sub: string }[];
  thread: OpsMessage[];
};

export const OPS_TASK_DETAILS: Record<string, OpsTaskDetail> = {
  "task-smoke": {
    kind: "general", description: "Replace smoke detector batteries", houseId: "prop-alder", room: "Room 2", residentId: "res-tom", assignee: "none",
    scheduleDate: "", startTime: "", endTime: "", timing: "deadline", priority: "high", dueDate: "2025-09-22",
    notes: "Chirping reported in the Room 2 hallway. Batteries are in the supply closet.", checklist: "Test each detector\nReplace 9V batteries\nLog the date on the panel",
    attachments: "", status: "Open", created: "Sep 15", linked: [{ id: "l-prop", title: "Alder House", sub: "Property" }], thread: [],
  },
  "task-keys": {
    kind: "general", description: "Order spare mailbox keys", houseId: "prop-willow", room: "", residentId: "", assignee: "none",
    scheduleDate: "", startTime: "", endTime: "", timing: "deadline", priority: "medium", dueDate: "2025-10-03",
    notes: "Two spares for the Willow Court mailbox.", checklist: "", attachments: "", status: "Open", created: "Sep 18",
    linked: [{ id: "l-prop", title: "Willow Court", sub: "Property" }], thread: [],
  },
  "task-spigots": {
    kind: "general", description: "Winterize outdoor spigots", houseId: "prop-maple", room: "", residentId: "", assignee: "vendor-pacific",
    scheduleDate: "", startTime: "", endTime: "", timing: "deadline", priority: "medium", dueDate: "2025-10-15",
    notes: "Shut off and drain the two exterior spigots before the first freeze.", checklist: "Shut off the interior valve\nDrain both spigots\nFit insulated covers",
    attachments: "", status: "Assigned", created: "Sep 20", linked: [{ id: "l-prop", title: "Maple Duplex", sub: "Property" }],
    thread: [
      { id: "m1", author: "Manager", body: "Can you winterize the two spigots at Maple Duplex before Oct 15?", at: "Sep 20, 9:05 AM", direction: "outbound" },
      { id: "m2", author: VENDOR_NAME, body: "Yes, I can do it the week of Oct 6. I'll bring the covers.", at: "Sep 20, 11:40 AM", direction: "inbound" },
    ],
  },
  "task-lock": {
    kind: "general", description: "Re-key Fremont Studio lock", houseId: "prop-fremont", room: "", residentId: "", assignee: "vendor-cascade",
    scheduleDate: "", startTime: "", endTime: "", timing: "deadline", priority: "high", dueDate: "2025-10-01",
    notes: "Re-key before the next move-in; three keys to the front desk.", checklist: "Re-key the deadbolt\nCut three keys", attachments: "",
    status: "Assigned", created: "Sep 22", linked: [{ id: "l-prop", title: "Fremont Studio", sub: "Property" }],
    thread: [{ id: "m1", author: "Manager", body: "Please re-key the Fremont Studio deadbolt by Oct 1.", at: "Sep 22, 2:10 PM", direction: "outbound" }],
  },
  "task-carpet": {
    kind: "move-in", description: "Carpet cleaning before move-in", houseId: "prop-willow", room: "Room 3", residentId: "", assignee: "vendor-rainier",
    scheduleDate: "2025-09-26", startTime: "13:30", endTime: "15:30", timing: "scheduled", priority: "medium", dueDate: "",
    notes: "Steam clean the Room 3 carpet and the hallway runner.", checklist: "Vacuum first\nSteam clean\nCheck for stains", attachments: "",
    status: "Scheduled", created: "Sep 19", linked: [{ id: "l-prop", title: "Willow Court · Room 3", sub: "Property" }],
    thread: [
      { id: "m1", author: "Manager", body: "Booked you for Fri, Sep 26 at 1:30 PM for the Room 3 carpet.", at: "Sep 19, 3:00 PM", direction: "outbound" },
      { id: "m2", author: "Rainier Cleaning", body: "Confirmed. See you then.", at: "Sep 19, 3:12 PM", direction: "inbound" },
    ],
  },
  "task-gutter": {
    kind: "general", description: "Clear the gutters", houseId: "prop-alder", room: "", residentId: "", assignee: "none",
    scheduleDate: "", startTime: "", endTime: "", timing: "deadline", priority: "low", dueDate: "2025-09-20",
    notes: "Front and back gutters cleared.", checklist: "Front gutters\nBack gutters", attachments: "", status: "Completed", created: "Sep 10",
    linked: [{ id: "l-prop", title: "Alder House", sub: "Property" }], thread: [],
  },
};

export const OPS_TASK_KIND_OPTIONS: { value: OpsTaskDetail["kind"]; label: string }[] = [
  { value: "general", label: "General" },
  { value: "move-in", label: "Move in" },
  { value: "move-out", label: "Move out" },
  { value: "tour", label: "Tour" },
  { value: "service", label: "Service" },
];

/** A blank task for the round + (the Add task popup opens with these defaults). */
export const OPS_NEW_TASK: OpsTaskDetail = {
  kind: "general", description: "Inspect the back stairs", houseId: "prop-alder", room: "", residentId: "", assignee: "me",
  scheduleDate: "2025-09-30", startTime: "10:00", endTime: "11:00", timing: "scheduled", priority: "medium", dueDate: "",
  notes: "", checklist: "", attachments: "", status: "Open", created: "Sep 25", linked: [], thread: [],
};

/* ───────────────────────────── Bookings ───────────────────────────── */

export type OpsBookingDetail = {
  email: string;
  phone: string;
  nights: number;
  rateCalc: string;
  total: string;
  channel?: string;
  /** Channel stays cannot be edited here; only a block (direct) booking can. */
  isChannel: boolean;
  notes?: string;
  linen?: string;
  baggage?: string;
  earlyCheckIn?: string;
  lateCheckOut?: string;
  pastStays: number;
  lastStay?: string;
  charges: { id: string; title: string; sub: string; figure: string }[];
  thread: OpsMessage[];
};

export const OPS_BOOKING_DETAILS: Record<string, OpsBookingDetail> = {
  "bk-1": {
    email: "hannah.brooks@guest.airbnb.example", phone: "(206) 555-0142", nights: 7, rateCalc: "7 nights x $96", total: "$672.00",
    channel: "Airbnb · HMQ7K2Z9", isChannel: true, pastStays: 0, charges: [],
    thread: [{ id: "m1", author: "Hannah Brooks", body: "Hi! Is there a spot to leave my bags before the 3 PM check-in?", at: "Sep 24, 6:20 PM", direction: "inbound" }],
  },
  "bk-2": {
    email: "", phone: "", nights: 3, rateCalc: "3 nights x $118", total: "$354.00", isChannel: false, notes: "Held for a prospective guest while they finish the application.",
    pastStays: 0, charges: [], thread: [],
  },
  "bk-3": {
    email: "tom.weaver@guest.booking.example", phone: "(425) 555-0119", nights: 6, rateCalc: "6 nights x $96", total: "$576.00",
    channel: "Booking.com · 4417820931", isChannel: true, earlyCheckIn: "14:00", pastStays: 1, lastStay: "Aug 3 – Aug 8",
    charges: [{ id: "c1", title: "Cleaning fee", sub: "Paid", figure: "$60.00" }],
    thread: [
      { id: "m1", author: "Tom Weaver", body: "Arriving a bit early on the 22nd, around 2 PM. Is that okay?", at: "Sep 20, 8:45 AM", direction: "inbound" },
      { id: "m2", author: "Manager", body: "Yes, Room 2 will be ready by 2.", at: "Sep 20, 9:10 AM", direction: "outbound" },
    ],
  },
  "bk-4": {
    email: "elena.cruz@example.com", phone: "(206) 555-0177", nights: 5, rateCalc: "5 nights x $142", total: "$710.00", isChannel: false,
    notes: "Direct booking, paid in full.", linen: "Delivered", baggage: "No", pastStays: 2, lastStay: "Jun 12 – Jun 16",
    charges: [{ id: "c1", title: "Stay total", sub: "Paid", figure: "$710.00" }],
    thread: [{ id: "m1", author: "Elena Cruz", body: "Thanks, the studio was perfect.", at: "Sep 9, 10:30 AM", direction: "inbound" }],
  },
};

export const OPS_BOOKING_SOURCES = ["Direct", "Tenant", "Airbnb", "Booking.com", "Application", "Other"];

/* ───────────────────────────── Promotion ───────────────────────────── */

export type OpsPromotionDetail = {
  /** What the asset is, for the pop-up's body and the Edit pop-up's defaults. */
  kindId: "flyer" | "text" | "upload";
  headline: string;
  body: string;
  price?: string;
  bullets?: string[];
  cta?: string;
  contact?: string;
  fileName?: string;
  textFormat?: string;
};

export const OPS_PROMOTION_DETAILS: Record<string, OpsPromotionDetail> = {
  "promo-willow-flyer": {
    kindId: "flyer", headline: "Room 3 now open at Willow Court", body: "A bright furnished room in Wallingford, walking distance to the Burke-Gilman Trail.",
    price: "$1,080/mo", bullets: ["Furnished with utilities included", "Shared kitchen and two baths", "Laundry in the house", "Open house Saturday Sep 27 at 11 AM"],
    cta: "Book a tour", contact: "(206) 555-0100 · hello@seattlehomes.example",
  },
  "promo-room3": {
    kindId: "text", headline: "Room 3 listing blurb", body: "Room 3 at Willow Court is available Oct 1. A furnished room in a friendly Wallingford house, utilities and wifi included, a short walk to the Burke-Gilman Trail and the 44 bus.\n\nTours are open this week. Message us to book a time.",
    textFormat: "Listing blurb",
  },
  "promo-fremont": {
    kindId: "text", headline: "Fremont Studio caption", body: "Morning light, a full kitchen and the canal at your door. The Fremont Studio is ready for a long stay.",
    textFormat: "Instagram caption",
  },
  "promo-alder-photos": { kindId: "upload", headline: "Alder House kitchen photo", body: "", fileName: "alder-house-kitchen.jpg" },
};

/** The houses a promotion can be made for: the Property select of the New promotion pop-up. */
export const OPS_PROMOTION_PROPERTIES = OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }));

export const OPS_FLYER_TEMPLATES = ["Classic", "Modern", "Bold", "Minimal", "Photo-first"];

/* ───────────────────────────── Outgoing payments ───────────────────────────── */

export type OpsOutgoingDetail = {
  invoice: string;
  service: string;
  state: "approved" | "scheduled" | "paid";
  managerEntered: boolean;
  lines: { description: string; quantity: number; amount: string }[];
  history: { id: string; title: string; sub: string; figure?: string }[];
  vendorEmail: string;
  thread: OpsMessage[];
};

export const OPS_OUTGOING_DETAILS: Record<string, OpsOutgoingDetail> = {
  "out-evergreen": {
    invoice: "INV-3018", service: "Outlet repair", state: "approved", managerEntered: false,
    lines: [{ description: "Outlet replacement (labor)", quantity: 2, amount: "$160.00" }, { description: "GFCI outlet", quantity: 1, amount: "$80.00" }],
    history: [{ id: "h1", title: "Billed by Evergreen Electric · INV-3018", sub: "Sep 22", figure: "$240.00" }, { id: "h2", title: "Approved", sub: "Sep 23" }],
    vendorEmail: "dispatch@evergreen.example",
    thread: [{ id: "m1", author: "Evergreen Electric", body: "Invoice INV-3018 for the Alder House outlet repair is attached.", at: "Sep 22, 4:05 PM", direction: "inbound" }],
  },
  "out-cascade": {
    invoice: "INV-221", service: "Lock replacement", state: "approved", managerEntered: true,
    lines: [{ description: "Deadbolt and cylinder", quantity: 1, amount: "$95.00" }],
    history: [{ id: "h1", title: "Bill entered", sub: "Sep 24", figure: "$95.00" }],
    vendorEmail: "", thread: [],
  },
  "out-rainier": {
    invoice: "INV-0457", service: "Move-out clean", state: "scheduled", managerEntered: false,
    lines: [{ description: "Move-out clean", quantity: 1, amount: "$180.00" }],
    history: [
      { id: "h1", title: "Billed by Rainier Cleaning · INV-0457", sub: "Sep 18", figure: "$180.00" },
      { id: "h2", title: "Approved", sub: "Sep 19" },
      { id: "h3", title: "Scheduled to pay", sub: "Oct 1" },
    ],
    vendorEmail: "office@rainiercleaning.example",
    thread: [{ id: "m1", author: "Rainier Cleaning", body: "Thanks for approving, we will be paid on Oct 1.", at: "Sep 19, 1:20 PM", direction: "inbound" }],
  },
  "out-pacific": {
    invoice: "INV-1142", service: "Slow bathroom drain", state: "paid", managerEntered: false,
    lines: [{ description: "Drain clearing (labor)", quantity: 1, amount: "$110.00" }, { description: "Parts", quantity: 1, amount: "$30.00" }],
    history: [
      { id: "h1", title: `Billed by ${VENDOR_NAME} · INV-1142`, sub: "Sep 12", figure: "$140.00" },
      { id: "h2", title: "Approved", sub: "Sep 13" },
      { id: "h3", title: "Paid with PropLane balance", sub: "Sep 15", figure: "$140.00" },
    ],
    vendorEmail: "jobs@pacificplumbing.example",
    thread: [{ id: "m1", author: VENDOR_NAME, body: "Drain is clear and tested. Invoice sent.", at: "Sep 12, 3:30 PM", direction: "inbound" }],
  },
};

export const OPS_PAYEES: { value: string; label: string }[] = [
  { value: "payee-chase", label: "Chase Home Lending · Mortgage lender" },
  { value: "payee-scl", label: "Seattle City Light · Utility" },
];

export const OPS_TEAMMATES: { value: string; label: string }[] = [{ value: "team-sam", label: "Sam Rivera · Property manager" }];

/** The vendors "A vendor" lists. A vendor with a PropLane login pays by invoice (one step). */
export const OPS_PAY_VENDORS: { value: string; label: string; hasLogin: boolean }[] = [
  { value: "v-pacific", label: VENDOR_NAME, hasLogin: true },
  { value: "v-evergreen", label: "Evergreen Electric", hasLogin: true },
  { value: "v-rainier", label: "Rainier Cleaning", hasLogin: false },
];

/* ───────────────────────────── Finances ───────────────────────────── */

export type OpsReport = {
  id: string;
  label: string;
  group: "Reports" | "Statements" | "Owners and tax" | "Money held and owed" | "Bank and checks";
  /** Column headers, then rows of cells (money in dollars). The last row is a total when `total` is true. */
  columns: string[];
  rows: string[][];
  total?: boolean;
  /** Ledger (CSV) downloads instead of opening a page. */
  download?: boolean;
};

const MONTH_ROWS: string[][] = [
  ["Rent", "$8,950.00"],
  ["Service fees", "$0.00"],
  ["Cleaning", "($180.00)"],
  ["Maintenance", "($240.00)"],
  ["Locks and keys", "($95.00)"],
  ["Net profit", "$8,435.00"],
];

export const OPS_REPORTS: OpsReport[] = [
  { id: "income-statement", label: "Profit and loss", group: "Reports", columns: ["Account", "Sep 2025"], rows: MONTH_ROWS, total: true },
  {
    id: "profitability", label: "By property", group: "Reports", columns: ["Property", "In", "Out", "Net"],
    rows: [["Alder House", "$1,650.00", "$240.00", "$1,410.00"], ["Maple Duplex", "$3,700.00", "$320.00", "$3,380.00"], ["Fremont Studio", "$1,400.00", "$95.00", "$1,305.00"], ["Willow Court", "$2,200.00", "$0.00", "$2,200.00"], ["Total", "$8,950.00", "$655.00", "$8,295.00"]],
    total: true,
  },
  { id: "financial-activity", label: "Ledger (CSV)", group: "Reports", columns: [], rows: [], download: true },
  { id: "cash-flow-statement", label: "Cash flow", group: "Statements", columns: ["Month", "In", "Out", "Net"], rows: [["Jul 2025", "$4,300.00", "$2,500.00", "$1,800.00"], ["Aug 2025", "$6,600.00", "$2,200.00", "$4,400.00"], ["Sep 2025", "$8,950.00", "$655.00", "$8,295.00"]] },
  { id: "trial-balance", label: "Trial balance", group: "Statements", columns: ["Account", "Debit", "Credit"], rows: [["Cash", "$21,540.00", ""], ["Security deposits held", "", "$5,200.00"], ["Rental income", "", "$8,950.00"], ["Maintenance", "$240.00", ""], ["Cleaning", "$180.00", ""], ["Owner equity", "", "$7,810.00"], ["Total", "$21,960.00", "$21,960.00"]], total: true },
  { id: "balance-sheet", label: "Balance sheet", group: "Statements", columns: ["Account", "Sep 25, 2025"], rows: [["Cash", "$21,540.00"], ["Total assets", "$21,540.00"], ["Security deposits held", "$5,200.00"], ["Accounts payable", "$335.00"], ["Owner equity", "$16,005.00"], ["Total liabilities and equity", "$21,540.00"]], total: true },
  { id: "general-ledger", label: "General ledger", group: "Statements", columns: ["Date", "Account", "Memo", "Amount"], rows: [["Sep 24", "Rental income", "Priya Nair · Room 1", "$1,080.00"], ["Sep 22", "Rental income", "Tomas Alvarez · Room 2", "$1,080.00"], ["Sep 15", "Plumbing", `${VENDOR_NAME} · INV-1142`, "($140.00)"], ["Sep 12", "Cleaning", "Rainier Cleaning", "($180.00)"]] },
  { id: "owner-statement", label: "Owner statement", group: "Owners and tax", columns: ["Property", "Income", "Expenses", "Owner share"], rows: [["Alder House", "$1,650.00", "$240.00", "$1,410.00"], ["Maple Duplex", "$3,700.00", "$320.00", "$3,380.00"]] },
  { id: "owner-distributions", label: "Distributions", group: "Owners and tax", columns: ["Date", "Owner", "Amount"], rows: [["Sep 1", "Alder House owner", "$1,200.00"], ["Aug 1", "Alder House owner", "$1,200.00"]] },
  { id: "budget-vs-actual", label: "Budget vs actual", group: "Owners and tax", columns: ["Category", "Budget", "Actual", "Left"], rows: [["Maintenance", "$500.00", "$240.00", "$260.00"], ["Cleaning", "$300.00", "$180.00", "$120.00"], ["Utilities", "$400.00", "$0.00", "$400.00"]] },
  { id: "security-deposits", label: "Deposits", group: "Money held and owed", columns: ["Resident", "Property", "Held"], rows: [["Priya Nair", "Willow Court · Room 1", "$1,080.00"], ["Liam Foster", "Alder House · Room 1", "$1,650.00"], ["Maya Chen", "Maple Duplex · Unit B", "$1,850.00"], ["Total", "", "$4,580.00"]], total: true },
  { id: "trust-account-balance", label: "Trust account", group: "Money held and owed", columns: ["", "Amount"], rows: [["Trust balance", "$4,580.00"], ["Deposits held", "$4,580.00"], ["Difference", "$0.00"]] },
  { id: "bills", label: "Bills", group: "Money held and owed", columns: ["Vendor", "For", "Due", "Amount"], rows: [["Evergreen Electric", "Outlet repair", "Sep 29", "$240.00"], ["Cascade Locksmiths", "Invoice INV-221", "Oct 2", "$95.00"]] },
  { id: "ap-aging", label: "AP aging", group: "Money held and owed", columns: ["Vendor", "Current", "1-30 days", "31+ days"], rows: [["Evergreen Electric", "$240.00", "$0.00", "$0.00"], ["Cascade Locksmiths", "$95.00", "$0.00", "$0.00"]] },
  { id: "payout-history", label: "Payout history", group: "Bank and checks", columns: ["Date", "Bank", "Status", "Amount"], rows: [["Sep 19", "Bank ····4821", "Paid", "$2,160.00"], ["Sep 5", "Bank ····4821", "Paid", "$3,300.00"]] },
  { id: "bank-reconciliation", label: "Bank reconciliation", group: "Bank and checks", columns: ["Statement", "Ledger", "Difference"], rows: [["$21,540.00", "$21,540.00", "$0.00"]] },
  { id: "financial-diagnostics", label: "Diagnostics", group: "Bank and checks", columns: ["Check", "Result"], rows: [["Rows that do not balance", "0"], ["Charges without a property", "0"], ["Payments without a charge", "0"]] },
];

/* ───────────────────────────── Documents ───────────────────────────── */

export const OPS_DOCUMENT_CATEGORIES = [
  "Insurance", "Tax", "Lease", "Inspection", "Receipt", "Legal", "Other",
];

export const OPS_DOCUMENT_VISIBILITY = ["Manager only", "Property owner", "Resident", "Vendor"];

export type OpsOtherDocument = {
  category: string;
  scope: string;
  size: string;
  propertyScoped: boolean;
  shared: boolean;
  type: string;
  uploaded: string;
};

export const OPS_OTHER_DOCUMENTS: Record<string, OpsOtherDocument> = {
  "doc-other-coi": { category: "Insurance", scope: "Portfolio", size: "214 KB", propertyScoped: false, shared: false, type: "application/pdf", uploaded: "Sep 3, 2025" },
  "doc-other-tax": { category: "Tax", scope: "Alder House", size: "98 KB", propertyScoped: true, shared: false, type: "application/pdf", uploaded: "Aug 14, 2025" },
};

export const OPS_DOCUMENT_SCOPES = [
  { id: "", label: "All scopes" },
  { id: "manager", label: "Manager-level" },
  { id: "property", label: "Property" },
  { id: "lease", label: "Lease" },
  { id: "resident", label: "Resident" },
  { id: "vendor", label: "Vendor" },
  { id: "work_order", label: "Work order" },
];

/** The application a Documents > Applications row opens as a document record. */
export type OpsApplicationDoc = {
  name: string;
  email: string;
  phone: string;
  place: string;
  status: string;
  submitted: string;
  moveIn: string;
  income: string;
  employer: string;
  references: string;
};

export const OPS_APPLICATION_DOCS: Record<string, OpsApplicationDoc> = {
  "doc-app-sample": { name: "Sample Applicant", email: "sample.applicant@example.com", phone: "(206) 555-0100", place: "Maple Duplex · Unit B", status: "Pending", submitted: "Sep 23, 2025", moveIn: "Oct 15, 2025", income: "$4,800/mo", employer: "Northwind Coffee", references: "2 provided" },
  "doc-app-alexis": { name: "Alexis Cole", email: "alexis.cole@example.com", phone: "(425) 555-0133", place: "Fremont Studio · Studio", status: "Rejected", submitted: "Sep 11, 2025", moveIn: "Oct 1, 2025", income: "$3,900/mo", employer: "Self-employed", references: "1 provided" },
};

/** The house each document row belongs to (its Property filter): "" for portfolio-level. */
export const OPS_DOC_HOUSE: Record<string, string> = {
  "doc-app-sample": "prop-maple",
  "doc-app-alexis": "prop-fremont",
  "doc-lease-priya": "prop-willow",
  "doc-lease-luis": "prop-fremont",
  "doc-other-coi": "",
  "doc-other-tax": "prop-alder",
};
