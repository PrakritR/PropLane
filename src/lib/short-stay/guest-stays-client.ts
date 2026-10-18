"use client";

/** Browser calls for the guest's Stays page and Book again sheet (`/api/resident/stays`). */
import type { PropertyStayTimes, StayAddOnKind } from "@/lib/bookings/stay-times";
import type { GuestBookAction, GuestRangeResult, GuestStay } from "@/lib/short-stay/guest-stays";
import type { StayAddOnQuoteRow } from "@/lib/short-stay/stay-add-ons";

export const GUEST_STAYS_CHANGED = "proplane:guest-stays-changed";

export type BookableListing = {
  propertyId: string;
  propertyLabel: string;
  rooms: Array<{ id: string; label: string; nightly: number; sleeps: number }>;
  confirmsInstantly: boolean;
  /** The standard times and add-on prices the sheet shows (the host's cleaning buffer is not sent). */
  stayTimes?: Omit<PropertyStayTimes, "cleaningBufferMinutes">;
};

export type GuestBookResponse = {
  ok: true;
  dryRun: boolean;
  results: GuestRangeResult[];
  action: GuestBookAction;
  summary: string;
};

export class GuestStaysError extends Error {
  readonly status: number;
  /** Per-range detail when the server refused every range (a 409 race keeps the cart). */
  readonly results: GuestRangeResult[] | null;
  constructor(message: string, status: number, results: GuestRangeResult[] | null = null) {
    super(message);
    this.status = status;
    this.results = results;
  }
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

export async function fetchGuestStays(): Promise<GuestStay[]> {
  const res = await fetch("/api/resident/stays", { credentials: "include", cache: "no-store" });
  const body = await readJson<{ stays?: GuestStay[] }>(res);
  if (!res.ok) throw new GuestStaysError(body.error || "Could not load your stays.", res.status);
  return Array.isArray(body.stays) ? body.stays : [];
}

export async function fetchBookableListing(propertyId: string): Promise<BookableListing | null> {
  const res = await fetch(`/api/resident/stays?propertyId=${encodeURIComponent(propertyId)}`, { credentials: "include", cache: "no-store" });
  if (res.status === 404) return null;
  const body = await readJson<{ listing?: BookableListing }>(res);
  if (!res.ok || !body.listing) throw new GuestStaysError(body.error || "Could not load that home.", res.status);
  return body.listing;
}

export async function postGuestStays(input: {
  propertyId: string;
  roomId: string;
  ranges: Array<{ checkIn: string; checkOut: string }>;
  guests: number;
  dryRun?: boolean;
  /** "HH:MM" the guest expects to arrive; omitted for "Not sure". */
  estimatedArrival?: string;
  /** Paid add-ons ticked in the sheet. */
  addOns?: StayAddOnKind[];
}): Promise<GuestBookResponse> {
  const res = await fetch("/api/resident/stays", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readJson<Partial<GuestBookResponse>>(res);
  if (!res.ok) {
    throw new GuestStaysError(body.error || "Could not save your booking.", res.status, Array.isArray(body.results) ? body.results : null);
  }
  return body as GuestBookResponse;
}

/* ───────────────── paid early check-in / late checkout (`/api/resident/stays/[blockId]/add-ons`) ───────────────── */

export type StayAddOnsView = {
  stay: {
    id: string;
    checkIn: string;
    checkOut: string;
    checkInTime: string;
    checkOutTime: string;
    estimatedArrival: string | null;
    status: "confirmed" | "hold";
  };
  rows: StayAddOnQuoteRow[];
};

export type StayAddOnRequestResult = {
  status: "pending" | "requested";
  kind: StayAddOnKind;
  time: string;
  priceCents: number;
  chargeId: string | null;
  checkoutUrl: string | null;
  paymentsPath: string | null;
};

export async function fetchStayAddOns(stayId: string): Promise<StayAddOnsView> {
  const res = await fetch(`/api/resident/stays/${encodeURIComponent(stayId)}/add-ons`, { credentials: "include", cache: "no-store" });
  const body = await readJson<Partial<StayAddOnsView>>(res);
  if (!res.ok || !body.stay || !body.rows) throw new GuestStaysError(body.error || "Could not load this stay.", res.status);
  return { stay: body.stay, rows: body.rows };
}

/** Asks for the add-on; the body carries the kind (and a time) and nothing that names who is asking or what it costs. */
export async function postStayAddOn(stayId: string, input: { kind: StayAddOnKind; time?: string }): Promise<StayAddOnRequestResult> {
  const res = await fetch(`/api/resident/stays/${encodeURIComponent(stayId)}/add-ons`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readJson<Partial<StayAddOnRequestResult>>(res);
  if (!res.ok || !body.status) throw new GuestStaysError(body.error || "Could not save that.", res.status);
  return body as StayAddOnRequestResult;
}
