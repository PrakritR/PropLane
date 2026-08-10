/**
 * Record-based links between tour inquiries and resident accounts.
 * Email is used only to verify ownership at link time — never as the identity key.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { INQUIRIES_RECORD_ID } from "@/lib/tour-inquiry.server";
import { inboxThreadSortMs, parseInboxStampMs } from "@/lib/portal-inbox-storage";
import { propertyManagerConversationThreadId } from "@/lib/property-manager-inbox-thread.server";
import { normalizeE164 } from "@/lib/twilio";

const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

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

export function isResidentTourLinksSchemaError(message: string): boolean {
  return /resident_tour_links|schema cache/i.test(message);
}

/** Email-scoped stand-in links when `resident_tour_links` is empty or not migrated yet. */
export async function tourLinksFromEmailInquiries(
  db: Db,
  params: { userId: string; email: string },
): Promise<ResidentTourLinkRow[]> {
  const email = normalizeEmail(params.email);
  if (!email.includes("@")) return [];

  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const now = new Date().toISOString();
  return inquiryRowsFromRecord(data?.row_data)
    .filter((row) => textField(row, "kind") === "tour" && normalizeEmail(textField(row, "email")) === email)
    .map((inquiry) => {
      const inquiryId = textField(inquiry, "id");
      return {
        id: `email:${inquiryId}`,
        resident_user_id: params.userId,
        inquiry_id: inquiryId,
        tour_group_id: textField(inquiry, "tourGroupId") || null,
        manager_user_id: textField(inquiry, "managerUserId") || textField(inquiry, "adminUserId") || null,
        property_id: textField(inquiry, "propertyId") || null,
        attendee_email: email,
        linked_at: textField(inquiry, "createdAt") || now,
      } satisfies ResidentTourLinkRow;
    })
    .filter((row) => row.inquiry_id);
}

export async function resolveResidentTourLinks(
  db: Db,
  params: { userId: string; email?: string | null },
): Promise<ResidentTourLinkRow[]> {
  const links = await loadResidentTourLinks(db, params.userId);
  if (links.length > 0) return links;
  const email = normalizeEmail(params.email);
  if (!email.includes("@")) return [];
  return tourLinksFromEmailInquiries(db, { userId: params.userId, email });
}

export async function loadResidentTourLinks(db: Db, userId: string): Promise<ResidentTourLinkRow[]> {
  const { data, error } = await db
    .from("resident_tour_links")
    .select("id, resident_user_id, inquiry_id, tour_group_id, manager_user_id, property_id, attendee_email, linked_at")
    .eq("resident_user_id", userId)
    .order("linked_at", { ascending: false });
  if (error) {
    if (isResidentTourLinksSchemaError(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as ResidentTourLinkRow[];
}

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
    if (!isResidentTourLinksSchemaError(error.message)) throw new Error(error.message);
  } else if ((count ?? 0) > 0) {
    return true;
  }

  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return false;
  const fallback = await tourLinksFromEmailInquiries(db, { userId, email: normalized });
  return fallback.length > 0;
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

  const { error } = await db.from("resident_tour_links").upsert(
    {
      resident_user_id: params.userId,
      inquiry_id: inquiryId,
      tour_group_id: tourGroupId,
      manager_user_id: managerUserId,
      property_id: propertyId,
      attendee_email: email,
      linked_at: new Date().toISOString(),
    },
    { onConflict: "resident_user_id,inquiry_id" },
  );
  if (error) return { ok: false, status: 400, error: error.message };

  await attachInboxThreadsToResident(db, params.userId, email);
  return { ok: true, linked: true, inquiryId };
}

/** Link every tour inquiry whose stored email matches (e.g. after account creation). */
export async function linkAllTourInquiriesForEmail(
  db: Db,
  params: { userId: string; email: string },
): Promise<string[]> {
  const email = normalizeEmail(params.email);
  if (!email.includes("@")) return [];

  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("id", INQUIRIES_RECORD_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const matching = inquiryRowsFromRecord(data?.row_data).filter(
    (row) => textField(row, "kind") === "tour" && normalizeEmail(textField(row, "email")) === email,
  );

  const linkedIds: string[] = [];
  for (const inquiry of matching) {
    const inquiryId = textField(inquiry, "id");
    if (!inquiryId) continue;
    const result = await linkTourInquiryToResident(db, {
      userId: params.userId,
      inquiryId,
      email,
    });
    if (result.ok) linkedIds.push(inquiryId);
  }
  return linkedIds;
}

/**
 * Backfill owner_user_id on inbox threads that were created before the account
 * existed (participant_email match only).
 */
export async function attachInboxThreadsToResident(db: Db, userId: string, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const { data: threads, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, owner_user_id")
    .eq("scope", RESIDENT_INBOX_SCOPE)
    .eq("participant_email", normalized)
    .is("owner_user_id", null)
    .limit(200);
  if (error || !threads?.length) return;

  const ids = threads.map((t) => t.id).filter(Boolean);
  if (!ids.length) return;
  await db
    .from("portal_inbox_thread_records")
    .update({ owner_user_id: userId, updated_at: new Date().toISOString() })
    .in("id", ids);
}

type InboxThreadMessage = {
  id: string;
  from: string;
  body: string;
  at: string;
  outbound?: boolean;
  channel?: string;
};

function threadMessages(rowData: Record<string, unknown> | null): InboxThreadMessage[] {
  if (!Array.isArray(rowData?.messages)) return [];
  return rowData.messages.filter(
    (item): item is InboxThreadMessage =>
      Boolean(item) && typeof item === "object" && typeof (item as InboxThreadMessage).id === "string",
  );
}

function messageSortKey(message: InboxThreadMessage, threadId: string): number {
  return parseInboxStampMs(message.at) ?? inboxThreadSortMs(threadId, message.at);
}

function mergeThreadMessages(
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
  primaryId: string,
  secondaryId: string,
): InboxThreadMessage[] {
  const seen = new Set<string>();
  const merged: InboxThreadMessage[] = [];
  for (const message of [...threadMessages(primary), ...threadMessages(secondary)]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  merged.sort(
    (a, b) => messageSortKey(a, primaryId) - messageSortKey(b, secondaryId) || a.id.localeCompare(b.id),
  );
  return merged;
}

function latestThreadActivity(rowData: Record<string, unknown>, messages: InboxThreadMessage[]): string {
  const latestMessage = messages[messages.length - 1];
  if (latestMessage?.at) return latestMessage.at;
  const time = typeof rowData.time === "string" ? rowData.time : "";
  return time;
}

async function mergeInboxThreadRecords(
  db: Db,
  input: {
    keepId: string;
    removeId: string;
    scope: string;
    participantEmail: string;
    ownerUserId?: string | null;
  },
): Promise<void> {
  if (input.keepId === input.removeId) return;

  const [{ data: keepRow }, { data: removeRow }] = await Promise.all([
    db.from("portal_inbox_thread_records").select("id, row_data, owner_user_id").eq("id", input.keepId).maybeSingle(),
    db.from("portal_inbox_thread_records").select("id, row_data").eq("id", input.removeId).maybeSingle(),
  ]);

  if (!removeRow?.row_data) return;

  const keepData = asObject(keepRow?.row_data) ?? {};
  const removeData = asObject(removeRow.row_data) ?? {};
  const messages = mergeThreadMessages(keepData, removeData, input.keepId, input.removeId);
  const activityTime = latestThreadActivity(
    messages.length ? { time: messages[messages.length - 1]?.at } : keepData,
    messages,
  );
  const previewSource =
    (typeof keepData.preview === "string" && keepData.preview.trim()) ||
    (typeof removeData.preview === "string" && removeData.preview.trim()) ||
    messages[messages.length - 1]?.body?.slice(0, 100).replace(/\n/g, " ") ||
    "";

  await db.from("portal_inbox_thread_records").upsert(
    {
      id: input.keepId,
      scope: input.scope,
      owner_user_id:
        input.ownerUserId ??
        (keepRow as { owner_user_id?: string | null } | null)?.owner_user_id ??
        null,
      participant_email: input.participantEmail,
      thread_type: "portal_message",
      row_data: {
        ...removeData,
        ...keepData,
        id: input.keepId,
        time: activityTime || keepData.time || removeData.time,
        preview: previewSource,
        unread: Boolean(keepData.unread) || Boolean(removeData.unread),
        ...(messages.length ? { messages } : {}),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  await db.from("portal_inbox_thread_records").delete().eq("id", input.removeId);
}

async function mergePropertyManagerThreadPair(
  db: Db,
  input: {
    userId: string;
    contactEmail: string;
    authEmail: string;
    managerUserId: string;
    propertyId: string;
  },
): Promise<void> {
  const canonicalId = propertyManagerConversationThreadId({
    residentEmail: input.contactEmail,
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
  });
  const alternateId = propertyManagerConversationThreadId({
    residentEmail: input.authEmail,
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
  });
  if (canonicalId === alternateId) return;

  for (const scope of [RESIDENT_INBOX_SCOPE, MANAGER_INBOX_SCOPE] as const) {
    const ownerUserId = scope === RESIDENT_INBOX_SCOPE ? input.userId : input.managerUserId;
    const participantEmail = input.contactEmail;

    const [{ data: canonical }, { data: alternate }] = await Promise.all([
      db.from("portal_inbox_thread_records").select("id").eq("id", canonicalId).eq("scope", scope).maybeSingle(),
      db.from("portal_inbox_thread_records").select("id").eq("id", alternateId).eq("scope", scope).maybeSingle(),
    ]);

    if (!alternate) continue;

    if (!canonical) {
      const { data: alternateRow } = await db
        .from("portal_inbox_thread_records")
        .select("row_data, owner_user_id, thread_type")
        .eq("id", alternateId)
        .maybeSingle();
      if (!alternateRow?.row_data) continue;
      await db.from("portal_inbox_thread_records").upsert(
        {
          id: canonicalId,
          scope,
          owner_user_id: ownerUserId,
          participant_email: participantEmail,
          thread_type: alternateRow.thread_type ?? "portal_message",
          row_data: { ...(asObject(alternateRow.row_data) ?? {}), id: canonicalId, email: participantEmail },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      await db.from("portal_inbox_thread_records").delete().eq("id", alternateId);
      continue;
    }

    await mergeInboxThreadRecords(db, {
      keepId: canonicalId,
      removeId: alternateId,
      scope,
      participantEmail,
      ownerUserId,
    });
  }
}

/** Collect property-scoped thread pairs that may exist under two prospect emails. */
async function propertyManagerPairsForEmails(
  db: Db,
  emails: string[],
): Promise<Array<{ managerUserId: string; propertyId: string }>> {
  const pairs = new Map<string, { managerUserId: string; propertyId: string }>();
  for (const email of emails) {
    const { data } = await db
      .from("portal_inbox_thread_records")
      .select("row_data")
      .eq("participant_email", email)
      .in("scope", [RESIDENT_INBOX_SCOPE, MANAGER_INBOX_SCOPE])
      .limit(200);
    for (const row of data ?? []) {
      const rowData = asObject(row.row_data);
      const propertyId = textField(rowData, "propertyId");
      const managerUserId = textField(rowData, "managerUserId");
      if (!propertyId || !managerUserId) continue;
      pairs.set(`${managerUserId}\0${propertyId}`, { managerUserId, propertyId });
    }
  }
  return [...pairs.values()];
}

async function mergeProspectInboxThreadsAcrossEmails(
  db: Db,
  input: { userId: string; contactEmail: string; authEmail: string },
): Promise<void> {
  const pairs = await propertyManagerPairsForEmails(db, [input.contactEmail, input.authEmail]);
  for (const pair of pairs) {
    await mergePropertyManagerThreadPair(db, { ...pair, ...input });
  }
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
  const auth = normalizeEmail(params.authEmail);
  if (!contact.includes("@")) return;

  await attachInboxThreadsToResident(db, params.userId, contact);
  if (auth && auth !== contact) {
    await attachInboxThreadsToResident(db, params.userId, auth);
    await mergeProspectInboxThreadsAcrossEmails(db, {
      userId: params.userId,
      contactEmail: contact,
      authEmail: auth,
    });
  }

  await applyProspectMessagingContactToProfile(db, {
    userId: params.userId,
    contactEmail: contact,
    phone: params.phone,
  });
}

export type ResidentTourView = {
  inquiryId: string;
  tourGroupId: string | null;
  status: string;
  propertyId: string | null;
  propertyTitle: string | null;
  roomLabel: string | null;
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

/** Load tour views scoped to linked inquiry ids (or email-matched inquiries as fallback). */
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
