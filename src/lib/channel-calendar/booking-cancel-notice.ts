"use client";

import { bookingEntryKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { invalidatePersistedInboxCache, MANAGER_INBOX_STORAGE_KEY, syncPersistedInboxFromServer } from "@/lib/portal-inbox-storage";

/**
 * C2-BK4 — "Notify guest" on Cancel booking.
 *
 * The notice goes out through the same authorized inbox send every other
 * manager message uses (`POST /api/portal/send-inbox-message`): the route
 * resolves and scopes the recipient first and only then appends to the thread
 * store and delivers by email, so a refused send leaves nothing behind. The
 * guest is reachable only when the stay carries an email; with none, the
 * checkbox is disabled instead of pretending.
 */

/** True when there is a channel to the guest — the send path addresses people by email. */
export function canNotifyBookingGuest(entry: Pick<PropertyBookingEntry, "residentEmail">): boolean {
  return Boolean(entry.residentEmail?.trim());
}

/** Every fact the guest needs: who, where, which dates. Editable nowhere — it is a system send. */
export function bookingCancelNoticeBody(entry: PropertyBookingEntry): { subject: string; text: string } {
  const guest = (entry.residentName || entry.summary || "").trim();
  const dates = formatBookingStayRange(entry.start, entry.end, entry.openEnded);
  const place = [entry.propertyLabel, entry.roomLabel].filter(Boolean).join(" · ");
  return {
    subject: `Your booking at ${entry.propertyLabel} was cancelled`,
    text: [
      `Hi${guest ? ` ${guest}` : ""},`,
      "",
      `Your booking has been cancelled.`,
      "",
      `Place: ${place}`,
      `Dates: ${dates}`,
      "",
      "Reply here if you have any questions.",
    ].join("\n"),
  };
}

export type BookingCancelNoticeResult = { ok: true } | { ok: false; error: string };

export async function sendBookingCancelNotice(
  entry: PropertyBookingEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<BookingCancelNoticeResult> {
  const to = entry.residentEmail?.trim().toLowerCase();
  if (!to) return { ok: false, error: "There is no email on file for this guest." };
  const { subject, text } = bookingCancelNoticeBody(entry);
  let fromName = "";
  let fromEmail = "";
  try {
    const profile = await fetchImpl("/api/profile", { credentials: "include" });
    if (profile.ok) {
      const data = (await profile.json()) as { fullName?: string; email?: string; profile?: { name?: string; email?: string } };
      fromName = String(data.fullName ?? data.profile?.name ?? "").trim();
      fromEmail = String(data.email ?? data.profile?.email ?? "").trim();
    }
  } catch {
    // The route falls back to the signed-in account's own identity.
  }
  const res = await fetchImpl("/api/portal/send-inbox-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      fromName,
      fromEmail,
      toEmails: [to],
      subject,
      text,
      deliverToPortalInbox: true,
      deliverViaEmail: true,
      deliverViaSms: false,
      eventCategory: "messages",
      senderPortal: "manager",
      ...(entry.propertyId ? { propertyId: entry.propertyId } : {}),
      recordRef: { kind: "booking", id: bookingEntryKey(entry), label: (entry.residentName || entry.summary || "Booking").trim() },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) return { ok: false, error: data.error || "Could not send the notice." };
  try {
    invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
    void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true });
  } catch {
    // The thread appears on the next inbox sync.
  }
  return { ok: true };
}
