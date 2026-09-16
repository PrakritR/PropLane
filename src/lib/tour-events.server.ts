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

/** Team-audience copy for a tour confirmation (WS5). Manager copy stays `renderTourManagerEvent`. */
export function renderTourTeamEvent(facts: { guestName: string; propertyTitle?: string; whenLabel?: string }): { subject: string; text: string; smsText: string } {
  const guest = facts.guestName.trim() || "A guest";
  const at = facts.propertyTitle?.trim() ? ` at ${facts.propertyTitle.trim()}` : "";
  const when = facts.whenLabel?.trim() ? ` for ${facts.whenLabel.trim()}` : "";
  const text = `A tour with ${guest}${at} is confirmed${when}.`;
  return { subject: `${guest} · Tour confirmed`, text, smsText: text };
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
  const recipients: Array<{ audience: "manager" | "team"; userId: string; rendered: { subject: string; text: string; smsText: string } }> = [
    { audience: "manager", userId: input.managerUserId, rendered: { ...rendered, text: `${rendered.text}\n\n${url}` } },
  ];
  // WS5: team hears about a confirmed tour (who is showing up); a guest
  // cancellation stays a manager-only nudge.
  if (input.event === "confirmed") {
    const teamRendered = renderTourTeamEvent(input);
    recipients.push({ audience: "team", userId: input.managerUserId, rendered: { ...teamRendered, text: `${teamRendered.text}\n\n${url}` } });
  }
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
    recipients,
  });
}

/**
 * A manager claims a shared/unassigned tour (WS4 territory — no "claim"
 * concept exists in the tour model yet; this is the team-audience emitter the
 * approved plan asks WS5 to provide so WS4's claim path can call it once it
 * exists). Team-only: the claim is news for the team, not the guest.
 *
 * Exported signature WS4 calls: `emitTourClaimedEvent(db, { managerUserId,
 * tourId, guestName, propertyTitle?, propertyId?, whenLabel?, claimedByUserId,
 * claimedByName })`.
 */
export async function emitTourClaimedEvent(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    tourId: string;
    guestName: string;
    propertyTitle?: string;
    propertyId?: string;
    whenLabel?: string;
    /** The manager who claimed it — the acting sender, attributed "I'm taking…". */
    claimedByUserId: string;
    claimedByName?: string;
  },
): Promise<void> {
  const { data: claimer } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("id", input.claimedByUserId)
    .maybeSingle();
  const senderEmail = String(claimer?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const senderName = input.claimedByName?.trim() || String(claimer?.full_name ?? "").trim() || undefined;
  const guest = input.guestName.trim() || "a guest";
  const at = input.propertyTitle?.trim() ? ` at ${input.propertyTitle.trim()}` : "";
  const when = input.whenLabel?.trim() ? `the ${input.whenLabel.trim()} ` : "the ";
  const text = `Heads up team — I'm taking ${when}tour with ${guest}${at}.`;
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/tours`;
  await emitActionEvent(db, {
    eventId: `${input.tourId}:claimed:${input.claimedByUserId}`,
    domain: "tour",
    event: "claimed",
    managerUserId: input.managerUserId,
    entityId: input.tourId,
    category: "leases",
    senderUserId: input.claimedByUserId,
    senderEmail,
    senderName,
    payload: { propertyId: input.propertyId ?? null, claimedByUserId: input.claimedByUserId },
    templateContext: {
      guestName: input.guestName,
      propertyTitle: input.propertyTitle ?? "",
      whenLabel: input.whenLabel ?? "",
      claimedByName: senderName ?? "",
      url,
    },
    recipients: [{ audience: "team", userId: input.managerUserId, rendered: { subject: `${guest} · Tour claimed`, text: `${text}\n\n${url}`, smsText: text } }],
  });
}

/**
 * A manager changes their availability (WS4/calendar territory — team-only
 * notice). `summary` is a short, already-formatted description of what
 * changed ("blocked Fri 2-5pm", "cleared Saturday"); this emitter does not
 * interpret calendar state itself.
 *
 * `changeKey` is the idempotency key for THIS change — the save path derives
 * it from what actually changed (record + date + windows), so a retried save
 * never re-notifies and two saves a second apart that changed different
 * windows both do. Absent, the key falls back to the summary text.
 */
export async function emitAvailabilityChangedEvent(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    changedByUserId: string;
    changedByName?: string;
    summary: string;
    entityId?: string;
    propertyId?: string | null;
    changeKey?: string;
  },
): Promise<void> {
  const { data: actor } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("id", input.changedByUserId)
    .maybeSingle();
  const senderEmail = String(actor?.email ?? "").trim().toLowerCase();
  if (!senderEmail) return;
  const senderName = input.changedByName?.trim() || String(actor?.full_name ?? "").trim() || undefined;
  const summary = input.summary.trim();
  if (!summary) return;
  const text = `${senderName ?? "A teammate"} ${summary}.`;
  const entityId = input.entityId ?? input.changedByUserId;
  await emitActionEvent(db, {
    eventId: `${entityId}:availability_changed:${input.changeKey?.trim() || summary}`,
    domain: "availability",
    event: "changed",
    managerUserId: input.managerUserId,
    entityId,
    category: "messages",
    senderUserId: input.changedByUserId,
    senderEmail,
    senderName,
    payload: { propertyId: input.propertyId ?? null },
    templateContext: { changedByName: senderName ?? "", summary },
    recipients: [{ audience: "team", userId: input.managerUserId, rendered: { subject: "Availability changed", text, smsText: text } }],
  });
}
