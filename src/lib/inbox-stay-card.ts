/**
 * The stay card pinned at the top of a one-on-one resident conversation (A3, stay chat): the home, the room,
 * the dates, the rent and the next payment of the stay the chat is about, with the three things either side
 * does next.
 *
 * DERIVED ON READ. Nothing here is stored: the card is recomputed from the person's current lease, booking or
 * approved application in this workspace every time the thread opens, so it can never disagree with the lease
 * page. Pure and client-safe; `use-inbox-stay-card.ts` feeds it from the stores the portal already reads.
 *
 * Precedence: a live lease (sent or signed) > an upcoming or current booking > an approved application whose
 * lease has not gone out yet (the empty state: "Application approved · lease not sent yet"). Nothing live and
 * nothing approved = no card.
 */
import { formatLeaseRentLabel } from "@/lib/resident-lease-display";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";

export type StayCardViewer = "manager" | "resident";

export type StayCardLease = {
  id: string;
  homeLabel: string;
  roomLabel?: string | null;
  /** The monthly rent as the lease stored it. */
  rentLabel?: string | null;
  start?: string | null;
  end?: string | null;
  /** draft = not sent to the resident yet; sent = waiting on a signature; signed = fully executed. */
  phase: "draft" | "sent" | "signed";
  photoUrl?: string | null;
};

export type StayCardBooking = {
  id: string;
  homeLabel: string;
  roomLabel?: string | null;
  checkIn: string;
  checkOut: string;
  totalLabel?: string | null;
  /** A cancelled or declined stay is no stay. */
  live: boolean;
  photoUrl?: string | null;
};

export type StayCardApplication = {
  id: string;
  homeLabel: string;
  roomLabel?: string | null;
  approved: boolean;
  photoUrl?: string | null;
};

/** A charge reduced to what "next payment" needs. */
export type StayCardCharge = {
  unpaid: boolean;
  /** Epoch ms of the due date; null = undated. */
  dueMs: number | null;
};

export type StayCardAction = { id: "pay" | "lease" | "service" | "charge" | "record"; label: string; href: string };

export type StayCard = {
  source: "lease" | "booking" | "application";
  title: string;
  /** Photo of the home when the listing has a real one; otherwise the caller draws `NoImagePlaceholder`. */
  photoUrl: string | null;
  fact: string;
  actions: StayCardAction[];
};

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function shortDay(date: Date, withYear: boolean): string {
  return date.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

/** "Nov 1 – Apr 30", with years only when the stay crosses one. Either end may be missing. */
export function stayDatesLabel(start: string | null | undefined, end: string | null | undefined): string {
  const from = parseFlexibleLocalDate(start);
  const to = parseFlexibleLocalDate(end);
  if (from && to) {
    const crossesYear = from.getFullYear() !== to.getFullYear();
    return `${shortDay(from, crossesYear)} – ${shortDay(to, crossesYear)}`;
  }
  if (from) return `from ${shortDay(from, false)}`;
  if (to) return `until ${shortDay(to, false)}`;
  return "";
}

/** "next payment Nov 1" from the soonest unpaid, dated charge; empty when nothing is owed on a date. */
export function nextPaymentLabel(charges: readonly StayCardCharge[] | undefined): string {
  let soonest: number | null = null;
  for (const charge of charges ?? []) {
    if (!charge.unpaid || charge.dueMs == null || !Number.isFinite(charge.dueMs)) continue;
    if (soonest == null || charge.dueMs < soonest) soonest = charge.dueMs;
  }
  return soonest == null ? "" : `next payment ${shortDay(new Date(soonest), false)}`;
}

function titleOf(home: string, room: string | null | undefined): string {
  const place = clean(home) || "Your home";
  const roomLabel = clean(room);
  return roomLabel && !place.toLowerCase().includes(roomLabel.toLowerCase()) ? `${place} · ${roomLabel}` : place;
}

function actionsFor(viewer: StayCardViewer, source: StayCard["source"]): StayCardAction[] {
  if (viewer === "resident") {
    if (source === "application") return [{ id: "lease", label: "Lease", href: "/resident/lease" }];
    return [
      { id: "pay", label: "Pay", href: "/resident/payments" },
      { id: "lease", label: "Lease", href: "/resident/lease" },
      { id: "service", label: "Request service", href: "/resident/services" },
    ];
  }
  if (source === "application") return [{ id: "record", label: "Record", href: "/portal/residents" }];
  return [
    { id: "charge", label: "Charge", href: "/portal/payments" },
    { id: "lease", label: "Lease", href: "/portal/leases" },
    { id: "record", label: "Record", href: "/portal/residents" },
  ];
}

function join(parts: Array<string | null | undefined>): string {
  return parts.map(clean).filter(Boolean).join(" · ");
}

export type StayCardInput = {
  viewer: StayCardViewer;
  /** The person's leases in THIS workspace, newest first. */
  leases?: readonly StayCardLease[];
  bookings?: readonly StayCardBooking[];
  applications?: readonly StayCardApplication[];
  charges?: readonly StayCardCharge[];
  now?: Date;
};

/**
 * The card for one person, or null when they have no stay to show. A booking that has already ended is not
 * current; a lease is current until it is replaced (voided leases are never passed in).
 */
export function deriveStayCard(input: StayCardInput): StayCard | null {
  const { viewer } = input;
  const live = (input.leases ?? []).filter((lease) => lease.phase !== "draft");
  const lease = live.find((candidate) => candidate.phase === "signed") ?? live[0];
  if (lease) {
    const rent = formatLeaseRentLabel(lease.rentLabel) ?? "";
    const state =
      lease.phase === "signed"
        ? viewer === "manager"
          ? "lease signed"
          : ""
        : viewer === "manager"
          ? "lease sent"
          : "lease ready to sign";
    return {
      source: "lease",
      title: titleOf(lease.homeLabel, lease.roomLabel),
      photoUrl: clean(lease.photoUrl) || null,
      fact: join([stayDatesLabel(lease.start, lease.end), rent, lease.phase === "signed" ? nextPaymentLabel(input.charges) : "", state]),
      actions: actionsFor(viewer, "lease"),
    };
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const booking = (input.bookings ?? [])
    .filter((candidate) => candidate.live)
    .filter((candidate) => {
      const out = parseFlexibleLocalDate(candidate.checkOut);
      // A stay checks out at the end of its last day.
      return !out || out.getTime() + 24 * 60 * 60_000 > nowMs;
    })
    .sort((a, b) => (parseFlexibleLocalDate(a.checkIn)?.getTime() ?? 0) - (parseFlexibleLocalDate(b.checkIn)?.getTime() ?? 0))[0];
  if (booking) {
    return {
      source: "booking",
      title: titleOf(booking.homeLabel, booking.roomLabel),
      photoUrl: clean(booking.photoUrl) || null,
      fact: join([stayDatesLabel(booking.checkIn, booking.checkOut), booking.totalLabel, nextPaymentLabel(input.charges)]),
      actions: actionsFor(viewer, "booking"),
    };
  }
  const application =
    (input.applications ?? []).find((candidate) => candidate.approved) ??
    (input.leases ?? []).map((candidate): StayCardApplication => ({
      id: candidate.id,
      homeLabel: candidate.homeLabel,
      roomLabel: candidate.roomLabel,
      approved: true,
      photoUrl: candidate.photoUrl,
    }))[0];
  if (application) {
    return {
      source: "application",
      title: titleOf(application.homeLabel, application.roomLabel),
      photoUrl: clean(application.photoUrl) || null,
      fact: "Application approved · lease not sent yet",
      actions: actionsFor(viewer, "application"),
    };
  }
  return null;
}

/** The lease fields the card reads, structurally typed so the pure derivation never imports the lease store. */
export type StayLeaseRowLike = {
  id: string;
  unit?: string | null;
  roomChoice?: string | null;
  signedRentLabel?: string | null;
  application?: { leaseStart?: string | null; leaseEnd?: string | null } | null;
  sentToResidentAt?: string | null;
  fullySignedAt?: string | null;
  voidedAt?: string | null;
};

/** A lease row as a stay-card lease, or null for a voided one. `roomLabel` is resolved by the caller (the listing). */
export function stayCardLeaseFromRow(row: StayLeaseRowLike, roomLabel: string, photoUrl?: string | null): StayCardLease | null {
  if (row.voidedAt) return null;
  return {
    id: row.id,
    homeLabel: clean(row.unit),
    roomLabel,
    rentLabel: row.signedRentLabel ?? null,
    start: row.application?.leaseStart ?? null,
    end: row.application?.leaseEnd ?? null,
    phase: row.fullySignedAt ? "signed" : row.sentToResidentAt ? "sent" : "draft",
    photoUrl: photoUrl ?? null,
  };
}
