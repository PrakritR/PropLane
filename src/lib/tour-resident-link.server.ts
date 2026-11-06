/**
 * Record-based links between tour inquiries and resident accounts.
 * Email is used only to verify ownership at link time — never as the identity key.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeTourFormat, type TourFormat } from "@/lib/tour-format";
import { INQUIRIES_RECORD_ID } from "@/lib/tour-inquiry.server";
import { normalizeE164 } from "@/lib/twilio";


type Db = SupabaseClient;

function normalizeEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Rows from the shared partner-inquiries singleton payload. */
export function inquiryRowsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

/** Load a single tour inquiry by id from the singleton record. */
export async function loadTourInquiryById(db: Db, inquiryId: string): Promise<Record<string, unknown> | null> {
  const id = inquiryId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const rows = inquiryRowsFromRecord(data?.row_data);
  const row = rows.find((item) => textField(item, "id") === id);
  if (!row || textField(row, "kind") !== "tour") return null;
  return row;
}

export type ResidentTourLinkRow = {
  id: string;
  resident_user_id: string;
  inquiry_id: string;
  tour_group_id: string | null;
  manager_user_id: string | null;
  property_id: string | null;
  attendee_email: string;
  linked_at: string;
};

/**
 * The table is genuinely ABSENT (a database that has not run the links migration) — the one
 * `resident_tour_links` condition that is not a read failure. Decided on the error CODE alone:
 * `42P01` is Postgres `undefined_table` and `PGRST205` is PostgREST's "table not found in the
 * schema cache". A message test would also swallow `permission denied`, a constraint and a
 * statement timeout on this table, which are failures and must be reported as such.
 */
export function isResidentTourLinksSchemaError(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  const code = String(error?.code ?? "").trim().toUpperCase();
  return code === "42P01" || code === "PGRST205";
}

/** Existing links are scoped to their original Auth subject. */
export async function resolveResidentTourLinks(
  db: Db,
  params: { userId: string; email?: string | null },
): Promise<ResidentTourLinkRow[]> {
  return loadResidentTourLinks(db, params.userId);
}

export async function residentHasExactTourLink(db: Db, userId: string, inquiryId: string): Promise<boolean> {
  const { data, error } = await db.from("resident_tour_links").select("inquiry_id").eq("resident_user_id", userId).eq("inquiry_id", inquiryId).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function loadResidentTourLinks(db: Db, userId: string): Promise<ResidentTourLinkRow[]> {
  const { data, error } = await db
    .from("resident_tour_links")
    .select("id, resident_user_id, inquiry_id, tour_group_id, manager_user_id, property_id, attendee_email, linked_at")
    .eq("resident_user_id", userId)
    .order("linked_at", { ascending: false });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as ResidentTourLinkRow[];
}

/**
 * ONE error rule for this table, shared with `loadResidentTourLinks`: any read failure throws.
 * This used to swallow the failure and answer `false`, so a PostgREST blip dropped a prospect's
 * pre-lease nav while `GET /api/portal-resident-tours` 500d on the same request — two different
 * answers to one unreadable table. An absent table (`isResidentTourLinksSchemaError`) is the only
 * non-failure, and it answers `false` because there are no links to hold.
 */
export async function residentHasTourLinks(
  db: Db,
  userId: string,
  email?: string | null,
): Promise<boolean> {
  const { count, error } = await db
    .from("resident_tour_links")
    .select("id", { count: "exact", head: true })
    .eq("resident_user_id", userId);
  if (error) {
    if (isResidentTourLinksSchemaError(error)) return false;
    throw new Error(error.message);
  }

  void email;
  return (count ?? 0) > 0;
}

export type LinkTourInquiryResult =
  | { ok: true; linked: boolean; inquiryId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Link a tour inquiry to a resident account. The inquiry email must match the
 * caller's verified email — record id is the identity, email is the gate.
 */
export async function linkTourInquiryToResident(
  db: Db,
  params: {
    userId: string;
    inquiryId: string;
    email: string;
  },
): Promise<LinkTourInquiryResult> {
  const inquiryId = params.inquiryId.trim();
  const email = normalizeEmail(params.email);
  if (!inquiryId) return { ok: false, status: 400, error: "Tour inquiry id is required." };
  if (!email.includes("@")) return { ok: false, status: 400, error: "A valid email is required." };

  const inquiry = await loadTourInquiryById(db, inquiryId);
  if (!inquiry) return { ok: false, status: 404, error: "Tour inquiry not found." };

  const inquiryEmail = normalizeEmail(textField(inquiry, "email"));
  if (!inquiryEmail || inquiryEmail !== email) {
    return { ok: false, status: 403, error: "This tour is not linked to your email." };
  }

  const tourGroupId = textField(inquiry, "tourGroupId") || null;
  const managerUserId = textField(inquiry, "managerUserId") || textField(inquiry, "adminUserId") || null;
  const propertyId = textField(inquiry, "propertyId") || null;

  const { data, error } = await db.rpc("bind_resident_tour_link", { p_user_id: params.userId, p_inquiry_id: inquiryId, p_group_id: tourGroupId, p_manager_id: managerUserId, p_property_id: propertyId, p_email: email });
  if (error) return { ok: false, status: 400, error: error.message };
  if (data !== true) return { ok: false, status: 403, error: "This tour is linked to another account." };

  return { ok: true, linked: true, inquiryId };
}

import { isBlockedSelfServiceProfileEmail } from "@/lib/auth/prospect-contact-trust";

/** Keep tour/message contact details on the profile for outbound Communication identity. */
export async function applyProspectMessagingContactToProfile(
  db: Db,
  input: { userId: string; contactEmail: string; phone?: string | null },
): Promise<void> {
  const contactEmail = normalizeEmail(input.contactEmail);
  if (!contactEmail.includes("@") || isBlockedSelfServiceProfileEmail(contactEmail)) return;

  const phone = input.phone?.trim() ? normalizeE164(input.phone.trim()) : null;
  const { data: profile } = await db.from("profiles").select("email, phone").eq("id", input.userId).maybeSingle();
  const patch: Record<string, string | null> = {};
  if ((profile?.email as string | undefined)?.trim().toLowerCase() !== contactEmail) {
    patch.email = contactEmail;
  }
  if (phone && (profile?.phone as string | undefined)?.trim() !== phone) {
    // Changing the number MUST retire its verification. `phone_verified_at` is a
    // trust signal, not decoration: `portal-inbox-delivery` treats a verified
    // number as a deliverable SMS destination, and `claw-manager-actions` treats
    // it as an authorized inbound-SMS identity for agent commands including
    // financial ones. Writing a new number while leaving the old stamp in place
    // meant an UNVERIFIED number inherited the previous number's authority —
    // and this route accepts `phone` from any authenticated caller, so it could
    // not be closed client-side.
    patch.phone = phone;
    patch.phone_verified_at = null;
  }
  if (!Object.keys(patch).length) return;
  await db.from("profiles").update(patch).eq("id", input.userId);
}

/**
 * Link pre-account inbox threads to a resident and merge property conversations
 * that were split across the prospect form email and the signed-in auth email.
 */
export async function reconcileProspectInboxThreadsForResident(
  db: Db,
  params: {
    userId: string;
    contactEmail: string;
    authEmail?: string | null;
    phone?: string | null;
  },
): Promise<void> {
  const contact = normalizeEmail(params.contactEmail);
  if (!contact.includes("@")) return;
  await applyProspectMessagingContactToProfile(db, { userId: params.userId, contactEmail: contact, phone: params.phone });
}

export type ResidentTourView = {
  inquiryId: string;
  tourGroupId: string | null;
  status: string;
  propertyId: string | null;
  propertyTitle: string | null;
  roomLabel: string | null;
  /** Always normalized; older rows read as in person. */
  tourFormat: TourFormat;
  managerUserId: string | null;
  managerLabel: string | null;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  notes: string | null;
  instructions: string | null;
  proposedStart: string | null;
  proposedEnd: string | null;
  requestedWindows: Array<{ start: string; end: string }>;
  createdAt: string | null;
  confirmed: boolean;
  confirmedStart: string | null;
  confirmedEnd: string | null;
};

const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

function plannedEventsFromRecord(rowData: unknown): Record<string, unknown>[] {
  const payload = asObject(rowData)?.payload;
  return Array.isArray(payload) ? payload.filter((item): item is Record<string, unknown> => Boolean(asObject(item))) : [];
}

/** The confirmed planned event a link points at, by inquiry id or tour group. */
function plannedTourForLink(
  planned: Record<string, unknown>[],
  link: ResidentTourLinkRow,
): Record<string, unknown> | undefined {
  return planned.find(
    (event) =>
      textField(event, "kind") === "tour" &&
      // A cancelled event is not a confirmed tour, whoever cancelled it.
      !textField(event, "canceledAt") &&
      (textField(event, "sourceInquiryId") === link.inquiry_id ||
        (Boolean(link.tour_group_id) && textField(event, "tourGroupId") === link.tour_group_id)),
  );
}

/**
 * The resident's view of a tour whose inquiry row is gone because it was
 * confirmed. Every field comes off the planned event, falling back to the
 * link's own columns — the link is the only surviving record of the request.
 */
function viewFromPlannedEvent(event: Record<string, unknown>, link: ResidentTourLinkRow): ResidentTourView {
  const start = textField(event, "start") || null;
  const end = textField(event, "end") || null;
  return {
    inquiryId: link.inquiry_id,
    tourGroupId: textField(event, "tourGroupId") || link.tour_group_id,
    status: "confirmed",
    propertyId: textField(event, "propertyId") || link.property_id,
    propertyTitle: textField(event, "propertyTitle") || null,
    roomLabel: textField(event, "roomLabel") || null,
    tourFormat: normalizeTourFormat(event.tourFormat),
    managerUserId: textField(event, "managerUserId") || textField(event, "adminUserId") || link.manager_user_id,
    managerLabel: textField(event, "adminLabel") || null,
    guestName: textField(event, "attendeeName") || null,
    guestEmail: textField(event, "attendeeEmail") || link.attendee_email || null,
    guestPhone: textField(event, "attendeePhone") || null,
    notes: textField(event, "notes") || null,
    instructions: textField(event, "instructions") || null,
    proposedStart: start,
    proposedEnd: end,
    requestedWindows: start && end ? [{ start, end }] : [],
    createdAt: link.linked_at,
    confirmed: true,
    confirmedStart: start,
    confirmedEnd: end,
  };
}

type TourCapabilitySource = { inquiry_id: string; recipient_email: string; manager_user_id: string; property_id: string; tour_group_id: string | null };

/** The source must still be pending or a matching, non-cancelled confirmed tour. */
export async function tourCapabilityEligible(db: Db, cap: TourCapabilitySource): Promise<boolean> {
  const inquiry = await loadTourInquiryById(db, cap.inquiry_id);
  let source: Record<string, unknown> | undefined;
  if (inquiry) {
    source = inquiry;
    const status = textField(source, "status").toLowerCase();
    if (status && status !== "pending") return false;
    if (normalizeEmail(textField(source, "email")) !== cap.recipient_email || textField(source, "propertyId") !== cap.property_id || (textField(source, "managerUserId") || textField(source, "adminUserId")) !== cap.manager_user_id || (textField(source, "tourGroupId") || null) !== cap.tour_group_id) return false;
  } else {
    const { data: planned, error: plannedError } = await db.from("portal_schedule_records").select("row_data").eq("id", PLANNED_RECORD_ID).maybeSingle();
    if (plannedError) return false;
    source = plannedEventsFromRecord(planned?.row_data).find((event) => textField(event, "kind") === "tour" && !textField(event, "canceledAt") && (textField(event, "sourceInquiryId") === cap.inquiry_id || (cap.tour_group_id && textField(event, "tourGroupId") === cap.tour_group_id)) && textField(event, "propertyId") === cap.property_id && (textField(event, "sourceManagerUserId") || textField(event, "managerUserId") || textField(event, "adminUserId")) === cap.manager_user_id && normalizeEmail(textField(event, "attendeeEmail")) === cap.recipient_email);
    if (!source) return false;
  }
  return true;
}

/** Link the exact inquiry authorized by a consumed, server-owned invitation. */
export async function linkTourFromCapability(db: Db, input: { userId: string; email: string; inquiryId: string; capabilityId: string }): Promise<boolean> {
  const { data: cap, error } = await db.from("tour_signup_capabilities").select("id, inquiry_id, recipient_email, manager_user_id, property_id, tour_group_id, consumed_at, consumed_user_id").eq("id", input.capabilityId).maybeSingle();
  if (error || !cap || !cap.consumed_at || cap.consumed_user_id !== input.userId || cap.inquiry_id !== input.inquiryId || cap.recipient_email !== normalizeEmail(input.email)) return false;
  if (!(await tourCapabilityEligible(db, cap))) return false;
  const linked = await db.rpc("bind_resident_tour_link", { p_user_id: input.userId, p_inquiry_id: cap.inquiry_id, p_group_id: cap.tour_group_id, p_manager_id: cap.manager_user_id, p_property_id: cap.property_id, p_email: cap.recipient_email });
  return !linked.error && linked.data === true;
}

/** Load tour views scoped to linked inquiry ids. */
export async function loadResidentTourViews(
  db: Db,
  userId: string,
  options?: { email?: string | null },
): Promise<ResidentTourView[]> {
  const links = await resolveResidentTourLinks(db, { userId, email: options?.email });
  if (!links.length) return [];

  const { data: inquiryRecord } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  const inquiries = inquiryRowsFromRecord(inquiryRecord?.row_data);

  const { data: plannedRecord } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", PLANNED_RECORD_ID)
    .maybeSingle();
  const planned = plannedEventsFromRecord(plannedRecord?.row_data);

  const views: ResidentTourView[] = [];
  // A slot with several hosts books ONE inquiry per manager under a shared
  // `tourGroupId`, and confirming collapses the whole group into a SINGLE
  // planned event. Without this the surviving links would each render the same
  // booking, reading as "Confirmed N" for one tour.
  const seenPlannedEventIds = new Set<string>();
  for (const link of links) {
    const inquiry = inquiries.find((row) => textField(row, "id") === link.inquiry_id);

    const confirmedEvent = plannedTourForLink(planned, link);
    // Confirming a tour CONSUMES its inquiry row (`confirmTourInquiry` writes
    // the inquiry payload back without it), so a resident whose tour was
    // confirmed has a link with no inquiry and a planned event instead.
    // Skipping it here reported "Confirmed 0" to a resident with a booked
    // tour — a confident zero off a fully successful read. Only a link with
    // NEITHER side is genuinely gone.
    if (!inquiry) {
      if (!confirmedEvent) continue;
      const plannedEventId = textField(confirmedEvent, "id");
      if (plannedEventId) {
        if (seenPlannedEventIds.has(plannedEventId)) continue;
        seenPlannedEventIds.add(plannedEventId);
      }
      views.push(viewFromPlannedEvent(confirmedEvent, link));
      continue;
    }

    const inquiryId = textField(inquiry, "id");

    const requestedWindows = Array.isArray(inquiry.requestedWindows)
      ? (inquiry.requestedWindows as unknown[])
          .map(asObject)
          .filter(Boolean)
          .map((w) => ({
            start: textField(w, "start"),
            end: textField(w, "end"),
          }))
          .filter((w) => w.start && w.end)
      : [];

    views.push({
      inquiryId,
      tourGroupId: textField(inquiry, "tourGroupId") || link.tour_group_id,
      status: confirmedEvent ? "confirmed" : textField(inquiry, "status") || "pending",
      propertyId: textField(inquiry, "propertyId") || link.property_id,
      propertyTitle: textField(inquiry, "propertyTitle") || null,
      roomLabel: textField(inquiry, "roomLabel") || null,
      // A confirmed event is the later, authoritative record of the tour.
      tourFormat: normalizeTourFormat(confirmedEvent ? confirmedEvent.tourFormat : inquiry.tourFormat),
      managerUserId: textField(inquiry, "managerUserId") || link.manager_user_id,
      managerLabel: textField(inquiry, "adminLabel") || null,
      guestName: textField(inquiry, "name") || null,
      guestEmail: textField(inquiry, "email") || link.attendee_email || null,
      guestPhone: textField(inquiry, "phone") || null,
      notes: textField(inquiry, "notes") || null,
      instructions: confirmedEvent ? textField(confirmedEvent, "instructions") || null : null,
      proposedStart: textField(inquiry, "proposedStart") || requestedWindows[0]?.start || null,
      proposedEnd: textField(inquiry, "proposedEnd") || requestedWindows[0]?.end || null,
      requestedWindows,
      createdAt: textField(inquiry, "createdAt") || link.linked_at,
      confirmed: Boolean(confirmedEvent),
      confirmedStart: confirmedEvent ? textField(confirmedEvent, "start") || null : null,
      confirmedEnd: confirmedEvent ? textField(confirmedEvent, "end") || null : null,
    });
  }
  return views;
}
