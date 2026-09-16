import "server-only";

/**
 * Manager-side tour events on the action-event bus (PLAN-0915 phase 3).
 *
 * The guest has always heard about a confirmation and a cancellation; the
 * manager only ever heard about the request. `confirmed` closes that gap when
 * auto-confirm booked the tour without them, and `cancelled_by_guest` turns
 * the inbox note the cancel path already writes into an alert that follows
 * their alert destination and can be switched off or reworded.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

export type TourManagerEvent = "confirmed" | "cancelled_by_guest";

export function renderTourManagerEvent(event: TourManagerEvent, facts: { guestName: string; propertyTitle?: string; whenLabel?: string; reason?: string }): { subject: string; text: string; smsText: string } {
  const guest = facts.guestName.trim() || "A guest";
  const at = facts.propertyTitle?.trim() ? ` at ${facts.propertyTitle.trim()}` : "";
  const when = facts.whenLabel?.trim() ? ` on ${facts.whenLabel.trim()}` : "";
  const text =
    event === "confirmed"
      ? `Tour confirmed: ${guest}${at}${when}. It is on your calendar.`
      : `${guest} cancelled their tour${at}${when}.${facts.reason?.trim() ? ` Reason: ${facts.reason.trim()}` : ""}`;
  return { subject: `${guest} · Tour ${event === "confirmed" ? "confirmed" : "cancelled"}`, text, smsText: text };
}

export async function emitTourManagerEvent(
  db: SupabaseClient,
  input: { event: TourManagerEvent; managerUserId: string; tourId: string; guestName: string; guestEmail?: string; propertyTitle?: string; propertyId?: string; whenLabel?: string; reason?: string },
): Promise<void> {
  const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", input.managerUserId).maybeSingle();
  const senderEmail = String(manager?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const rendered = renderTourManagerEvent(input.event, input);
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/tours`;
  await emitActionEvent(db, {
    eventId: `${input.tourId}:${input.event}:${input.whenLabel ?? ""}`,
    domain: "tour",
    event: input.event,
    managerUserId: input.managerUserId,
    entityId: input.tourId,
    category: "leases",
    senderUserId: input.managerUserId,
    senderEmail,
    senderName: String(manager?.full_name ?? "").trim() || undefined,
    payload: { guestEmail: input.guestEmail ?? null, propertyId: input.propertyId ?? null },
    templateContext: { guestName: input.guestName, propertyTitle: input.propertyTitle ?? "", whenLabel: input.whenLabel ?? "", url },
    recipients: [{ audience: "manager", userId: input.managerUserId, rendered: { ...rendered, text: `${rendered.text}\n\n${url}` } }],
  });
}
