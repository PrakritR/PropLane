/**
 * The renter the homepage Software demo follows from a text to a signed lease and a faucet: Jordan, at 61 Willow
 * Court. Each builder is one frame of that journey as the rows the real stores hold (an application, the charges,
 * the lease, the service), so `home-demo-effects.ts` can move the world forward by writing them through the same
 * store writers the portals use. Nothing here reaches a server.
 */
import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { HOME_DEMO_PROPERTY_IDS } from "@/lib/demo/demo-guided-data";
import { DEMO_MANAGER_USER_ID, DEMO_RESIDENT_USER_ID } from "@/lib/demo/demo-session";

export const HOME_DEMO_JORDAN = {
  name: "Jordan Ellis",
  firstName: "Jordan",
  email: "jordan.prospect@example.com",
  userId: DEMO_RESIDENT_USER_ID,
} as const;

const PLACE = "Willow Court · Room 3";
const RENT = 1080;
const APPLICATION_ID = "home-app-jordan";
const LEASE_ID = "home-lease-jordan";
export const HOME_DEMO_SERVICE_ID = "home-wo-willow-faucet";

function money(dollars: number): string {
  return `$${dollars.toLocaleString("en-US")}.00`;
}

/** Jordan's application: just submitted (waiting on the manager) or approved with the room placed. */
export function homeDemoJordanApplication(state: "submitted" | "approved"): DemoApplicantRow {
  const approved = state === "approved";
  return {
    id: APPLICATION_ID,
    name: HOME_DEMO_JORDAN.name,
    email: HOME_DEMO_JORDAN.email,
    property: "Willow Court",
    propertyId: HOME_DEMO_PROPERTY_IDS.willow,
    ...(approved ? { assignedPropertyId: HOME_DEMO_PROPERTY_IDS.willow, assignedRoomChoice: "Room 3", signedMonthlyRent: RENT } : {}),
    stage: approved ? "Approved" : "Submitted",
    bucket: approved ? "approved" : "pending",
    detail: "",
    managerUserId: DEMO_MANAGER_USER_ID,
  };
}

/** What Jordan owes up front: the application fee, the deposit and the first month's rent, unpaid or all paid. */
export function homeDemoJordanCharges(state: "pending" | "paid", nowMs: number): HouseholdCharge[] {
  const paid = state === "paid";
  const line = (id: string, kind: HouseholdCharge["kind"], title: string, dollars: number): HouseholdCharge => ({
    id: `home-charge-${id}`,
    createdAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
    applicationId: APPLICATION_ID,
    residentEmail: HOME_DEMO_JORDAN.email,
    residentName: HOME_DEMO_JORDAN.name,
    residentUserId: HOME_DEMO_JORDAN.userId,
    propertyId: HOME_DEMO_PROPERTY_IDS.willow,
    propertyLabel: "Willow Court",
    managerUserId: DEMO_MANAGER_USER_ID,
    kind,
    title,
    amountLabel: money(dollars),
    balanceLabel: paid ? "$0.00" : money(dollars),
    status: paid ? "paid" : "pending",
    blocksLeaseUntilPaid: false,
    ...(paid ? { paidAmountCents: dollars * 100, paidAt: new Date(nowMs).toISOString(), paidMethod: "bank" } : {}),
  });
  return [
    line("application-fee", "application_fee", "Application fee", 45),
    line("deposit", "security_deposit", "Security deposit", RENT),
    line("first-rent", "first_month_rent", "First month’s rent", RENT),
  ];
}

/** The lease document the manager sent (generated, as PropLane does): the terms of the one room Jordan applied for. */
const LEASE_HTML = `<h1>Residential lease</h1>
<p>This lease is between Seattle Homes (the manager) and Jordan Ellis (the resident).</p>
<h2>Home</h2>
<p>${PLACE}, 61 Willow Court, Seattle.</p>
<h2>Rent</h2>
<p>$${RENT.toLocaleString("en-US")} per month, due on the first of each month. A security deposit of $${RENT.toLocaleString("en-US")} is held for the resident.</p>
<h2>Term</h2>
<p>Twelve months from the move-in date, then month to month.</p>
<h2>Signatures</h2>
<p>The manager and the resident sign below.</p>`;

/** Jordan's lease: sent by the manager (waiting on Jordan) or signed by both. */
export function homeDemoJordanLease(state: "sent" | "signed", nowMs: number): LeasePipelineRow {
  const signed = state === "signed";
  const sentAt = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const signedAt = new Date(nowMs).toISOString();
  return {
    id: LEASE_ID,
    residentName: HOME_DEMO_JORDAN.name,
    residentEmail: HOME_DEMO_JORDAN.email,
    residentUserId: HOME_DEMO_JORDAN.userId,
    managerUserId: DEMO_MANAGER_USER_ID,
    propertyId: HOME_DEMO_PROPERTY_IDS.willow,
    unit: PLACE,
    stageLabel: signed ? "Fully signed" : "Waiting on resident signature",
    status: signed ? "Fully Signed" : "Resident Signature Pending",
    updated: (signed ? signedAt : sentAt).slice(0, 10),
    updatedAtIso: signed ? signedAt : sentAt,
    ...(signed ? { signedAtIso: signedAt, fullySignedAt: signedAt } : {}),
    managerSignature: { name: "Seattle Homes", signedAtIso: sentAt, role: "manager" },
    residentSignature: signed ? { name: HOME_DEMO_JORDAN.name, signedAtIso: signedAt, role: "resident" } : null,
    bucket: signed ? "signed" : "resident",
    pdfVersion: 1,
    notes: "",
    generatedHtml: LEASE_HTML,
    generatedAtIso: sentAt,
    signedRentLabel: `$${RENT.toLocaleString("en-US")}/mo`,
    thread: [],
  };
}

/** The service Jordan texts about once the lease is signed: the leaking kitchen faucet, with his photo. */
export function homeDemoJordanService(photo: string): DemoManagerWorkOrderRow {
  return {
    id: HOME_DEMO_SERVICE_ID,
    reference: "WO-2041",
    propertyName: "Willow Court",
    propertyId: HOME_DEMO_PROPERTY_IDS.willow,
    propertyAddress: "61 Willow Court",
    unit: PLACE,
    title: "Leaking kitchen faucet",
    priority: "Normal",
    status: "Open",
    bucket: "open",
    description: "The kitchen faucet is leaking.",
    scheduled: "",
    cost: "",
    category: "plumbing",
    managerUserId: DEMO_MANAGER_USER_ID,
    residentName: HOME_DEMO_JORDAN.name,
    residentEmail: HOME_DEMO_JORDAN.email,
    photoDataUrls: [photo],
  };
}
