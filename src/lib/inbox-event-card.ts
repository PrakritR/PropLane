/**
 * The event card an automated turn wears in a conversation (A3, stay chat).
 *
 * A turn PropLane generated from an action event or a reminder is stamped with
 * `eventKind` (what happened), `eventCard` (the bold title and one fact line,
 * rendered once at delivery from facts the sender knew) and a turn-level
 * `recordRef` (the record the card's action opens). The thread views draw a
 * stamped turn as a card: glyph, bold title, one muted fact line, one action
 * link. A turn WITHOUT a stamp (every row written before this) renders exactly
 * as it always did. Pure and client-safe: the writer (`deliverProjection`,
 * `dispatchReminderRow`) and the renderer share this one vocabulary.
 *
 * Nothing here is an authorization grant: the link is a plain section path the
 * viewer's own portal guards, and the `recordRef` is a label.
 */
import { normalizeRecordRef, type RecordRef } from "@/lib/portals/record-kinds";

export const INBOX_EVENT_KINDS = [
  "charge_created",
  "payment_received",
  "payment_failed",
  "late_fee_applied",
  "lease_sent",
  "lease_signed_by_resident",
  "lease_countersigned",
  "lease_signed",
  "application_approved",
  "tour_confirmed",
  "booking_confirmed",
  "booking_changed",
  "move_in_details",
  "room_assigned",
] as const;

export type InboxEventKind = (typeof INBOX_EVENT_KINDS)[number];

export function isInboxEventKind(value: unknown): value is InboxEventKind {
  return typeof value === "string" && (INBOX_EVENT_KINDS as readonly string[]).includes(value);
}

/** What the card says: a bold title and at most one fact line. */
export type InboxEventCard = { title: string; fact?: string };

/** Everything the send path stamps onto an automated turn. */
export type InboxEventStamp = {
  kind: InboxEventKind;
  card: InboxEventCard;
  recordRef?: RecordRef;
};

/** Which action events are cards. Anything else (processing, refunded, voided...) keeps the plain activity row. */
export function inboxEventKindFor(domain: string | null | undefined, event: string | null | undefined): InboxEventKind | null {
  const name = String(event ?? "").trim();
  if (!isInboxEventKind(name)) return null;
  const owner = String(domain ?? "").trim();
  if (name === "charge_created" || name === "payment_received" || name === "payment_failed" || name === "late_fee_applied") {
    return owner === "payment" ? name : null;
  }
  if (name.startsWith("lease_")) return owner === "lease" ? name : null;
  if (name === "application_approved") return owner === "application" ? name : null;
  if (name === "move_in_details" || name === "room_assigned") return owner === "move_in" ? name : null;
  if (name === "tour_confirmed") return owner === "tour" ? name : null;
  if (name === "booking_confirmed" || name === "booking_changed") return owner === "channel_booking" ? name : null;
  return null;
}

/** A stored `eventKind`, or undefined when absent or not one of ours (old rows, hand-edited rows). */
export function normalizeInboxEventKind(value: unknown): InboxEventKind | undefined {
  return isInboxEventKind(value) ? value : undefined;
}

const MAX_TITLE = 120;
const MAX_FACT = 220;

/** A stored `eventCard`, or undefined when structurally invalid. */
export function normalizeInboxEventCard(value: unknown): InboxEventCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE) : "";
  if (!title) return undefined;
  const fact = typeof raw.fact === "string" ? raw.fact.trim().slice(0, MAX_FACT) : "";
  return fact ? { title, fact } : { title };
}

function text(payload: Record<string, unknown> | null | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function ref(kind: RecordRef["kind"], id: string, label: string): RecordRef | undefined {
  return normalizeRecordRef({ kind, id, label }) ?? undefined;
}

export type InboxEventStampInput = {
  domain: string;
  event: string;
  audience: string;
  entityId?: string | null;
  /** The stored event payload (facts the emitter recorded). */
  payload?: Record<string, unknown> | null;
  rendered?: { subject?: string; text?: string };
};

/**
 * The stamp for one delivery, or null when the event is not a card or the copy is not the resident's. Built
 * from stored facts only (payload + entity id), so a retried delivery stamps exactly what the first attempt did.
 * Only the RESIDENT copy is stamped: the stay chat is the resident's conversation, and the manager's own side
 * of it is the sent copy of that same turn.
 */
export function buildInboxEventStamp(input: InboxEventStampInput): InboxEventStamp | null {
  if (input.audience !== "resident") return null;
  const kind = inboxEventKindFor(input.domain, input.event);
  if (!kind) return null;
  const payload = input.payload ?? null;
  const entityId = String(input.entityId ?? "").trim();
  const place = text(payload, "propertyLabel");
  const explicitFact = text(payload, "cardFact");
  const chargeTitle = text(payload, "title") || "Charge";
  const amount = text(payload, "amountLabel");
  const due = text(payload, "dueDateLabel");
  const propertyId = text(payload, "propertyId");
  let title: string;
  let fact: string | undefined;
  let recordRef: RecordRef | undefined;
  switch (kind) {
    case "charge_created":
      title = `${chargeTitle} due${due ? ` ${due}` : ""}${amount ? ` · ${amount}` : ""}`;
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("payment", entityId, chargeTitle) : undefined;
      break;
    case "payment_received":
      title = `${chargeTitle} paid`;
      fact = explicitFact || amount || undefined;
      recordRef = entityId ? ref("payment", entityId, chargeTitle) : undefined;
      break;
    case "payment_failed":
      title = `${chargeTitle} payment failed`;
      fact = explicitFact || amount || undefined;
      recordRef = entityId ? ref("payment", entityId, chargeTitle) : undefined;
      break;
    case "late_fee_applied":
      title = `Late fee${amount ? ` · ${amount}` : ""}`;
      fact = explicitFact || chargeTitle;
      recordRef = entityId ? ref("payment", entityId, chargeTitle) : undefined;
      break;
    case "lease_sent":
      title = "Lease ready to sign";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("lease", entityId, place || "Lease") : undefined;
      break;
    case "lease_signed_by_resident":
      title = "You signed the lease";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("lease", entityId, place || "Lease") : undefined;
      break;
    case "lease_countersigned":
      title = "Your manager signed the lease";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("lease", entityId, place || "Lease") : undefined;
      break;
    case "lease_signed":
      title = "Lease signed";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("lease", entityId, place || "Lease") : undefined;
      break;
    case "application_approved":
      title = "Application approved";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("application", entityId, place || "Application") : undefined;
      break;
    case "tour_confirmed":
      title = "Tour confirmed";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("tour", entityId, place || "Tour") : undefined;
      break;
    case "booking_confirmed":
    case "booking_changed":
      title = kind === "booking_confirmed" ? "Booking confirmed" : "Booking changed";
      fact = explicitFact || place || undefined;
      recordRef = entityId ? ref("booking", entityId, place || "Booking") : undefined;
      break;
    case "move_in_details":
      title = "Move-in details";
      fact = explicitFact || place || undefined;
      recordRef = propertyId ? ref("property", propertyId, place || "Home") : undefined;
      break;
    case "room_assigned": {
      const room = text(payload, "roomLabel");
      title = room ? `Room assigned: ${room}` : "Room assigned";
      fact = explicitFact || place || undefined;
      recordRef = propertyId ? ref("property", propertyId, place || "Home") : undefined;
      break;
    }
  }
  const card = normalizeInboxEventCard({ title, fact });
  if (!card) return null;
  return { kind, card, ...(recordRef ? { recordRef } : {}) };
}

export type InboxEventViewer = "manager" | "resident";

/** The glyph a kind wears. Names, not components: the renderer maps them to icons. */
export type InboxEventGlyph = "payment" | "lease" | "application" | "tour" | "booking" | "key" | "bed";

export function inboxEventGlyph(kind: InboxEventKind): InboxEventGlyph {
  switch (kind) {
    case "charge_created":
    case "payment_received":
    case "payment_failed":
    case "late_fee_applied":
      return "payment";
    case "lease_sent":
    case "lease_signed_by_resident":
    case "lease_countersigned":
    case "lease_signed":
      return "lease";
    case "application_approved":
      return "application";
    case "tour_confirmed":
      return "tour";
    case "booking_confirmed":
    case "booking_changed":
      return "booking";
    case "move_in_details":
      return "key";
    case "room_assigned":
      return "bed";
  }
}

/** The card's title for the viewer: the manager reads their own announcement as sent. */
export function inboxEventTitleFor(viewer: InboxEventViewer, kind: InboxEventKind, title: string): string {
  if (viewer === "manager" && kind === "move_in_details") return "Move-in details sent";
  return title;
}

/** The one action link: label and a section path the viewer's portal already serves. */
export function inboxEventAction(viewer: InboxEventViewer, kind: InboxEventKind): { label: string; href: string } | null {
  const base = viewer === "manager" ? "/portal" : "/resident";
  switch (kind) {
    case "charge_created":
    case "payment_failed":
    case "late_fee_applied":
      return { label: viewer === "resident" ? "Pay" : "View", href: `${base}/payments` };
    case "payment_received":
      return { label: "View", href: `${base}/payments` };
    case "lease_sent":
    case "lease_signed_by_resident":
    case "lease_countersigned":
    case "lease_signed":
      return { label: "View", href: viewer === "manager" ? "/portal/leases" : "/resident/lease" };
    case "application_approved":
      return { label: "View", href: `${base}/applications` };
    case "tour_confirmed":
      return { label: "View", href: viewer === "manager" ? "/portal/tours" : "/resident/tour" };
    case "booking_confirmed":
    case "booking_changed":
      return { label: "View", href: viewer === "manager" ? "/portal/bookings" : "/resident/stays" };
    case "move_in_details":
      return viewer === "manager"
        ? { label: "Edit", href: "/portal/properties" }
        : { label: "Open", href: "/resident/move-in" };
    case "room_assigned":
      return viewer === "manager"
        ? { label: "View", href: "/portal/properties" }
        : { label: "Open", href: "/resident/move-in" };
  }
}

/** The stamps a turn can carry, read loosely so any turn shape (stored, merged, backfilled) can be passed. */
type EventStampedTurn = {
  eventKind?: unknown;
  eventCard?: unknown;
  recordRef?: unknown;
  senderDisplayName?: unknown;
};

/** A stored `senderDisplayName` ("Dev · Co-host"): the label a co-host's reply wears under its bubble. */
export function normalizeSenderDisplayName(value: unknown): string | undefined {
  const label = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return label || undefined;
}

/**
 * The root-turn form of a turn's event stamps. The root turn lives in `body`, so its stamps live beside it as
 * `root*`. Every key is always present (undefined when the turn has none) so a merge that replaces the root
 * overwrites the previous root's stamps instead of inheriting them.
 */
export function rootEventFieldsFromTurn(turn: EventStampedTurn | null | undefined): {
  rootEventKind: InboxEventKind | undefined;
  rootEventCard: InboxEventCard | undefined;
  rootEventRecordRef: RecordRef | undefined;
  rootSenderDisplayName: string | undefined;
} {
  const kind = normalizeInboxEventKind(turn?.eventKind);
  const card = kind ? normalizeInboxEventCard(turn?.eventCard) : undefined;
  return {
    rootEventKind: card ? kind : undefined,
    rootEventCard: card,
    rootEventRecordRef: card ? normalizeRecordRef(turn?.recordRef) ?? undefined : undefined,
    rootSenderDisplayName: normalizeSenderDisplayName(turn?.senderDisplayName),
  };
}

/** The turn form of a stored row's `root*` stamps (only the keys that are present). */
export function turnEventFieldsFromRoot(row: Record<string, unknown> | null | undefined): {
  eventKind?: InboxEventKind;
  eventCard?: InboxEventCard;
  recordRef?: RecordRef;
  senderDisplayName?: string;
} {
  const kind = normalizeInboxEventKind(row?.rootEventKind);
  const card = kind ? normalizeInboxEventCard(row?.rootEventCard) : undefined;
  const recordRef = card ? normalizeRecordRef(row?.rootEventRecordRef) : null;
  const name = normalizeSenderDisplayName(row?.rootSenderDisplayName);
  return {
    ...(card ? { eventKind: kind, eventCard: card } : {}),
    ...(recordRef ? { recordRef } : {}),
    ...(name ? { senderDisplayName: name } : {}),
  };
}

/** What the bubble builders spread onto an `InboxBubbleMessage`: only valid stamps, never a guessed one. */
export function bubbleEventFields(turn: EventStampedTurn | null | undefined): {
  eventKind?: InboxEventKind;
  eventCard?: InboxEventCard;
  eventRecordRef?: RecordRef;
  senderDisplayName?: string;
} {
  const kind = normalizeInboxEventKind(turn?.eventKind);
  const card = kind ? normalizeInboxEventCard(turn?.eventCard) : undefined;
  const recordRef = card ? normalizeRecordRef(turn?.recordRef) : null;
  const name = normalizeSenderDisplayName(turn?.senderDisplayName);
  return {
    ...(card ? { eventKind: kind, eventCard: card } : {}),
    ...(recordRef ? { eventRecordRef: recordRef } : {}),
    ...(name ? { senderDisplayName: name } : {}),
  };
}
