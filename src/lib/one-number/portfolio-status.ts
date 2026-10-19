/**
 * The portfolio status a person who runs houses reads by text: pure types and the text builders.
 * No database and no clock: every figure here was produced by `readPortfolioStatus`
 * (portfolio-status.server.ts) from the same report functions the portal uses, and this file only
 * adds, orders and words them. A figure that could not be read is `null`, and a `null` is never
 * written as zero: the line is left out and the reply says it could not read that part.
 */
import { monthLabel, usd, whichHouseQuestion } from "@/lib/one-number/ops-text";
import type { StatusTopic } from "@/lib/one-number/line-intent";
import { toGsm7 } from "@/lib/one-number/segments";

export type HouseStatus = {
  propertyId: string;
  title: string;
  /** Rooms on the listing and how many are free today. null = the listing's rooms could not be read. */
  rooms: number | null;
  vacantRooms: number | null;
  /** This month's rent: collected, and still owed. null = not readable (or not in this person's access). */
  rentCollectedCents: number | null;
  rentOwedCents: number | null;
  unpaidResidents: number | null;
  /** Payments that landed in the last 7 days. */
  paidLast7: { count: number; cents: number } | null;
  /** Maintenance not yet done plus add-on requests still pending. */
  openServices: number | null;
  /** The next confirmed tour: Pacific day and clock, already worded. */
  nextTour: { day: string; time: string; startsAt: string } | null | undefined;
  /** Fully signed leases that end within 60 days: how many, and the earliest end (YYYY-MM-DD). */
  leasesEnding: { count: number; earliest: string | null } | null;
};

export type PortfolioStatus = {
  /** YYYY-MM the rent figures are for. */
  month: string;
  workspaceName: string;
  houses: HouseStatus[];
  /** Parts of the report that failed to read, by name ("rent", "services" ...). */
  unreadable: string[];
  /** Parts this person's access does not include (a teammate without Payments has no "rent"). Never a failure, never zero. */
  restricted: string[];
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const sum = (values: Array<number | null>): number | null => {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return values.reduce<number>((total, v) => total + (v as number), 0);
};

/** "Nov 30" for a YYYY-MM-DD. */
export function shortDay(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const label = (h: HouseStatus): string => h.title.trim() || "A house";

export type PortfolioTotals = {
  houses: number;
  rooms: number | null;
  vacantRooms: number | null;
  rentCollectedCents: number | null;
  rentOwedCents: number | null;
  unpaidResidents: number | null;
  openServices: number | null;
  leasesEnding: number | null;
};

/** Every total is a sum over the houses read; one unreadable house makes its total unreadable, not smaller. */
export function portfolioTotals(status: PortfolioStatus): PortfolioTotals {
  const h = status.houses;
  return {
    houses: h.length,
    rooms: sum(h.map((x) => x.rooms)),
    vacantRooms: sum(h.map((x) => x.vacantRooms)),
    rentCollectedCents: sum(h.map((x) => x.rentCollectedCents)),
    rentOwedCents: sum(h.map((x) => x.rentOwedCents)),
    unpaidResidents: sum(h.map((x) => x.unpaidResidents)),
    openServices: sum(h.map((x) => x.openServices)),
    leasesEnding: sum(h.map((x) => (x.leasesEnding ? x.leasesEnding.count : null))),
  };
}

function nextTourOverall(status: PortfolioStatus): { house: string; day: string; time: string } | null {
  const withTour = status.houses
    .filter((h) => h.nextTour)
    .sort((a, b) => a.nextTour!.startsAt.localeCompare(b.nextTour!.startsAt));
  return withTour.length ? { house: label(withTour[0]!), day: withTour[0]!.nextTour!.day, time: withTour[0]!.nextTour!.time } : null;
}

function overview(status: PortfolioStatus): string {
  const t = portfolioTotals(status);
  const parts: string[] = [];
  parts.push(`${status.workspaceName || "Your houses"}, ${monthLabel(status.month).split(" ")[0]}: ${plural(t.houses, "house")}`);
  if (t.rooms !== null && t.vacantRooms !== null && t.rooms > 0) {
    parts[0] += `, ${t.rooms - t.vacantRooms} of ${plural(t.rooms, "room")} occupied`;
  }
  const lines = [`${parts[0]}.`];
  if (t.rentCollectedCents !== null && t.rentOwedCents !== null) {
    const due = t.rentCollectedCents + t.rentOwedCents;
    if (due > 0) {
      lines.push(
        t.unpaidResidents
          ? `Rent collected ${usd(t.rentCollectedCents)} of ${usd(due)}, ${t.unpaidResidents} unpaid.`
          : `Rent collected ${usd(t.rentCollectedCents)} of ${usd(due)}, all paid.`,
      );
    }
  }
  if (t.openServices !== null) lines.push(t.openServices === 0 ? "No open services." : `${plural(t.openServices, "open service")}.`);
  const tour = nextTourOverall(status);
  if (tour) lines.push(`Next tour ${tour.day} ${tour.time} at ${tour.house}.`);
  if (t.leasesEnding) lines.push(`${plural(t.leasesEnding, "lease")} ending within 60 days.`);
  if (status.houses.length > 1 && status.houses.length <= 4) {
    for (const h of status.houses) {
      const bits: string[] = [];
      if (h.rooms !== null && h.vacantRooms !== null) bits.push(`${h.rooms - h.vacantRooms}/${h.rooms} occupied`);
      if (h.rentCollectedCents !== null && h.rentOwedCents !== null && h.rentCollectedCents + h.rentOwedCents > 0) {
        bits.push(`${usd(h.rentCollectedCents)} of ${usd(h.rentCollectedCents + h.rentOwedCents)} rent`);
      }
      if (h.openServices) bits.push(plural(h.openServices, "service"));
      if (bits.length) lines.push(`${label(h)}: ${bits.join(", ")}.`);
    }
  }
  if (status.unreadable.length) lines.push(`I could not read ${status.unreadable.join(" or ")} just now.`);
  return lines.join(" ");
}

function vacancies(status: PortfolioStatus): string {
  const known = status.houses.filter((h) => h.vacantRooms !== null);
  const open = known.filter((h) => (h.vacantRooms ?? 0) > 0);
  if (known.length === 0) return "I could not read your room availability just now. Try again in a minute.";
  if (open.length === 0) return `Every room is occupied across ${plural(known.length, "house")}.`;
  const list = open.slice(0, 6).map((h) => `${label(h)} ${h.vacantRooms} of ${h.rooms}`).join(", ");
  const total = open.reduce((n, h) => n + (h.vacantRooms ?? 0), 0);
  return `${plural(total, "room")} vacant now: ${list}.${open.length > 6 ? ` And ${open.length - 6} more houses.` : ""}`;
}

const notInAccess = (part: string) => `${part} is not part of your access on this line.`;

function rent(status: PortfolioStatus): string {
  const t = portfolioTotals(status);
  const month = monthLabel(status.month).split(" ")[0];
  if (status.restricted.includes("rent") && t.rentCollectedCents === null && !status.unreadable.includes("rent")) return notInAccess("Rent");
  if (t.rentCollectedCents === null || t.rentOwedCents === null) return `I could not read ${month} rent just now. Try again in a minute.`;
  const due = t.rentCollectedCents + t.rentOwedCents;
  if (due === 0) return `No ${month} rent charges yet.`;
  const head = `${month} rent: ${usd(t.rentCollectedCents)} collected of ${usd(due)}.`;
  if (!t.unpaidResidents) return `${head} Everyone has paid.`;
  const owing = status.houses
    .filter((h) => (h.unpaidResidents ?? 0) > 0)
    .slice(0, 5)
    .map((h) => `${label(h)} ${h.unpaidResidents} (${usd(h.rentOwedCents ?? 0)})`)
    .join(", ");
  return `${head} ${plural(t.unpaidResidents, "resident")} unpaid, ${usd(t.rentOwedCents)} owed: ${owing}.`;
}

function payments(status: PortfolioStatus): string {
  const known = status.houses.filter((h) => h.paidLast7 !== null);
  if (known.length === 0 && status.restricted.includes("rent") && !status.unreadable.includes("rent")) return notInAccess("Payments");
  if (known.length === 0) return "I could not read your payments just now. Try again in a minute.";
  const count = known.reduce((n, h) => n + (h.paidLast7?.count ?? 0), 0);
  const cents = known.reduce((n, h) => n + (h.paidLast7?.cents ?? 0), 0);
  if (count === 0) return "No payments came in over the last 7 days.";
  const byHouse = known
    .filter((h) => (h.paidLast7?.count ?? 0) > 0)
    .slice(0, 5)
    .map((h) => `${label(h)} ${usd(h.paidLast7!.cents)}`)
    .join(", ");
  return `${usd(cents)} came in over the last 7 days across ${plural(count, "payment")}: ${byHouse}.`;
}

function tours(status: PortfolioStatus): string {
  const known = status.houses.filter((h) => h.nextTour !== undefined);
  if (known.length === 0) return status.unreadable.includes("tours") ? "I could not read your tours just now. Try again in a minute." : notInAccess("Tours");
  const upcoming = known.filter((h) => h.nextTour);
  if (upcoming.length === 0) return "No tours are booked right now.";
  const list = upcoming.slice(0, 5).map((h) => `${label(h)} ${h.nextTour!.day} ${h.nextTour!.time}`).join("; ");
  return `Next tours: ${list}.`;
}

function services(status: PortfolioStatus): string {
  const known = status.houses.filter((h) => h.openServices !== null);
  if (known.length === 0 && status.restricted.includes("services") && !status.unreadable.includes("services")) return notInAccess("Services");
  if (known.length === 0) return "I could not read your services just now. Try again in a minute.";
  const total = known.reduce((n, h) => n + (h.openServices ?? 0), 0);
  if (total === 0) return "No open services.";
  const list = known
    .filter((h) => (h.openServices ?? 0) > 0)
    .slice(0, 6)
    .map((h) => `${label(h)} ${h.openServices}`)
    .join(", ");
  return `${plural(total, "open service")}: ${list}.`;
}

function leases(status: PortfolioStatus): string {
  const known = status.houses.filter((h) => h.leasesEnding !== null);
  if (known.length === 0 && status.restricted.includes("leases") && !status.unreadable.includes("leases")) return notInAccess("Leases");
  if (known.length === 0) return "I could not read your leases just now. Try again in a minute.";
  const ending = known.filter((h) => (h.leasesEnding?.count ?? 0) > 0);
  if (ending.length === 0) return "No leases end within the next 60 days.";
  const total = ending.reduce((n, h) => n + (h.leasesEnding?.count ?? 0), 0);
  const list = ending
    .slice(0, 5)
    .map((h) => `${label(h)} ${h.leasesEnding!.count}${h.leasesEnding!.earliest ? ` (first ${shortDay(h.leasesEnding!.earliest)})` : ""}`)
    .join(", ");
  return `${plural(total, "lease")} ending within 60 days: ${list}.`;
}

/** The reply for one status topic. GSM-7 safe. */
export function buildStatusReply(status: PortfolioStatus, topic: StatusTopic): string {
  if (status.houses.length === 0) return `I do not see any houses to report on for ${status.workspaceName || "this account"}.`;
  const body =
    topic === "vacancies" ? vacancies(status)
    : topic === "rent" ? rent(status)
    : topic === "payments" ? payments(status)
    : topic === "tours" ? tours(status)
    : topic === "services" ? services(status)
    : topic === "leases" ? leases(status)
    : overview(status);
  return toGsm7(body);
}

/** "Which house: A, B, or all?" is the ops layer's own wording; re-exported so callers need one import. */
export { whichHouseQuestion };

export const STATUS_HELP_REPLY =
  "Ask about your houses: status, vacancies, unpaid rent, tours, services or lease ends.";

/** A change request on the PropLane line is declined with where to make it. */
export function buildWriteDeclineReply(input: { workNumber: string | null; portalUrl: string; viewOnly: boolean }): string {
  if (input.viewOnly) {
    return toGsm7(`I can only share status on this line. Your account is view only, so changes are made by your PropLane team. See it here: ${input.portalUrl}`);
  }
  const where = input.workNumber ? `text your work number ${input.workNumber} or use the portal` : "use the portal";
  return toGsm7(`I can only share status on this line. To make a change, ${where}: ${input.portalUrl}`);
}
