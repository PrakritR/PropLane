import { BOOKING_ROWS } from "./site/product-mock/fixtures-more";
import { COMM_CONVERSATIONS, RESIDENT_NAME } from "./site/product-mock/fixtures";
import { NO_STORY, residentStory, worldFor, type DemoStory } from "./site/product-mock/world";

export const HOME_DASHBOARD_TABS = [
  { id: "communication", label: "Inbox", caption: "Every text lands in one inbox." },
  { id: "applications", label: "Applications", caption: "Applications come in. You approve one." },
  { id: "leases", label: "Leases", caption: "Leases are sent, signed and countersigned here." },
  { id: "services", label: "Services", caption: "A plumber is booked and everyone is told." },
  { id: "bookings", label: "Bookings", caption: "Stays and tours on one calendar." },
  { id: "payments", label: "Payments", caption: "Rent is collected and shows as paid." },
] as const;
export type HomeDashboardTab = (typeof HOME_DASHBOARD_TABS)[number]["id"];

export function homeDashboardStory(tab: HomeDashboardTab): DemoStory {
  if (tab === "applications") return residentStory("apply");
  if (tab === "leases") return residentStory("sign");
  if (tab === "services" || tab === "payments") return residentStory("pay");
  return NO_STORY;
}

/** The compact, server-rendered view reads the same rows as the enhanced panels. */
export function homeDashboardRows(tab: HomeDashboardTab) {
  const world = worldFor(homeDashboardStory(tab));
  switch (tab) {
    case "communication": return COMM_CONVERSATIONS.filter((row) => row.segment === "active").map((row) => ({ id: row.id, title: row.name, place: row.subtitle, detail: row.preview, figure: row.time }));
    case "applications": return world.applications.filter((row) => row.bucket === "pending").map((row) => ({ id: row.id, title: row.name, place: `${row.property} · ${row.unit}`, detail: row.stage, figure: row.submitted }));
    case "leases": return world.leases.filter((row) => row.bucket === "completed").map((row) => ({ id: row.id, title: row.resident, place: row.place, detail: row.stage, figure: row.updated }));
    case "services": return world.services.filter((row) => row.state === "scheduled").map((row) => ({ id: row.id, title: row.title, place: row.property, detail: row.detail, figure: "Scheduled" }));
    case "bookings": return BOOKING_ROWS.filter((row) => row.bucket === "upcoming").map((row) => ({ id: row.id, title: row.guest, place: row.place, detail: row.stay, figure: row.status }));
    case "payments": return world.payments.filter((row) => row.bucket === "paid").map((row) => ({ id: row.id, title: row.resident, place: row.property, detail: row.chargeTitle, figure: row.amount }));
  }
}

export function homeRentPaid() {
  return worldFor(residentStory("pay")).payments.find((row) => row.resident === RESIDENT_NAME && row.bucket === "paid")!;
}

export const HOME_DASHBOARD_PORTALS = [
  { id: "manager", label: "Manager", caption: "Your properties, people and payments." },
  { id: "resident", label: "Resident", caption: "Your home, lease and payments." },
  { id: "vendor", label: "Vendor", caption: "Your services and upcoming jobs." },
  { id: "owner", label: "Owner", caption: "The statements shared with you." },
] as const;
export type HomeDashboardPortal = (typeof HOME_DASHBOARD_PORTALS)[number]["id"];
