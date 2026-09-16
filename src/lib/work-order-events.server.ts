import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { actionDeliveryPolicy, emitActionEvent } from "@/lib/action-events.server";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders, type WebhookEventType } from "@/lib/webhooks/events";

/**
 * Only three transitions are published outward; the rest fold into `updated`.
 * The payload is built by the catalog's own builder, so the transition's facts
 * (title, property label, vendor name, resident contact) cannot leak outward.
 */
function outboundWebhook(
  event: WorkOrderEventType,
  workOrderId: string,
  occurredAt?: string,
): { type: WebhookEventType; payload: ReturnType<(typeof webhookEventBuilders)["work_order.updated"]> } {
  if (event === "created") {
    return { type: "work_order.created", payload: webhookEventBuilders["work_order.created"]({ workOrderId, status: event }) };
  }
  if (event === "completed") {
    return {
      type: "work_order.completed",
      payload: webhookEventBuilders["work_order.completed"]({ workOrderId, completedAt: occurredAt ?? null }),
    };
  }
  return { type: "work_order.updated", payload: webhookEventBuilders["work_order.updated"]({ workOrderId, status: event }) };
}

export type WorkOrderEventType =
  | "created"
  | "vendor_offered"
  | "vendor_declined"
  | "offer_expiring"
  | "offer_expired"
  | "offer_filled"
  | "accepted"
  | "scheduled"
  | "rescheduled"
  | "cancelled"
  | "en_route"
  | "completed"
  | "resident_confirmed"
  | "resident_reopened"
  | "auto_closed"
  | "rated"
  | "invoiced"
  | "invoice_approved"
  | "invoice_disputed"
  | "paid";
export type WorkOrderEventAudience = "manager" | "resident" | "vendor" | "team";

export type WorkOrderEventFacts = {
  reference: string;
  title: string;
  propertyLabel?: string;
  scheduledFor?: string;
  vendorName?: string;
  offerCount?: number;
  amountCents?: number;
  accessInstructions?: string;
  residentContact?: string;
  emergency?: boolean;
  /** "within 1 business day" — the manager's Services setting, for the filed acknowledgement. */
  responsePromise?: string;
  /** Number a resident can call for an emergency, when the manager has one. */
  emergencyPhone?: string;
  /** "Thu, Sep 18 at 4:00 PM" — when an offer expires. */
  expiresLabel?: string;
  /** Free text riding an event: a decline reason, a dispute note, a resident's "still dripping". */
  note?: string;
  residentName?: string;
  /** Signed "was this fixed?" link for the resident. */
  confirmUrl?: string;
  /** Signed rating link for the resident. */
  ratingUrl?: string;
  rating?: number;
  /** Rough travel time the vendor tapped, in minutes. */
  etaMinutes?: number;
  url?: string;
};

export type WorkOrderEventRecipient = {
  audience: WorkOrderEventAudience;
  userId?: string;
  email?: string;
};

export type RenderedWorkOrderEvent = { subject: string; text: string; smsText: string };

const money = (cents: number | undefined) =>
  typeof cents === "number" && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : "the submitted amount";

/** Pure renderer. It receives only facts allowed for this audience, preventing
 * resident notes/contact details from leaking into vendor or manager messages. */
export function renderWorkOrderEvent(
  event: WorkOrderEventType,
  audience: WorkOrderEventAudience,
  facts: WorkOrderEventFacts,
): RenderedWorkOrderEvent | null {
  const ref = facts.reference.trim() || "Work order";
  const title = facts.title.trim() || "Work order";
  const at = facts.propertyLabel?.trim() ? ` at ${facts.propertyLabel.trim()}` : "";
  const when = facts.scheduledFor?.trim() || "the scheduled time";
  const vendor = facts.vendorName?.trim() || "the vendor";
  let text: string | null = null;

  const note = facts.note?.trim();
  const noteSuffix = note ? `: “${note.slice(0, 160)}”` : "";
  const expires = facts.expiresLabel?.trim();

  if (event === "created") {
    if (audience === "manager") text = `${ref}: New work order “${title}”${at}. Review and assign it.`;
    if (audience === "resident") {
      const promise = facts.responsePromise?.trim();
      const emergency = facts.emergencyPhone?.trim();
      text = `${ref}: We received “${title}”${at}.${promise ? ` You will hear back ${promise}.` : ""}${emergency ? ` Emergency? Call ${emergency}.` : ""}`;
    }
  } else if (event === "vendor_offered") {
    if (audience === "vendor") text = `${ref}: New offer for “${title}”${at}.${expires ? ` Expires ${expires}.` : ""} Review it and respond.`;
    if (audience === "manager") text = `${ref}: Offer sent to ${facts.offerCount ?? 1} vendor${facts.offerCount === 1 ? "" : "s"}.${expires ? ` Expires ${expires}.` : ""}`;
  } else if (event === "vendor_declined") {
    if (audience === "manager") text = `${ref}: ${vendor} declined “${title}”${at}${noteSuffix}. Send it to someone else.`;
  } else if (event === "offer_expiring") {
    if (audience === "vendor") text = `${ref}: Your offer for “${title}”${at} expires ${expires || "soon"}. Accept or decline it.`;
  } else if (event === "offer_expired") {
    if (audience === "vendor") text = `${ref}: The offer for “${title}”${at} expired.`;
    if (audience === "manager") text = `${ref}: No vendor accepted “${title}”${at} before the offer expired. Re-offer it or widen the list.`;
  } else if (event === "offer_filled") {
    if (audience === "vendor") text = `${ref}: “${title}”${at} was filled by another vendor. Thanks for responding.`;
  } else if (event === "accepted") {
    if (audience === "resident") text = `${ref}: ${vendor} is booked for ${when}.`;
    if (audience === "vendor") text = `${ref}: Your offer was accepted for “${title}”${at}. Visit: ${when}.${facts.accessInstructions ? ` Access: ${facts.accessInstructions}` : ""}${facts.residentContact ? ` Resident contact: ${facts.residentContact}` : ""}`;
    if (audience === "manager") text = `${ref}: ${vendor} accepted “${title}” for ${money(facts.amountCents)}.`;
    if (audience === "team") text = `${ref}: ${vendor} was assigned to “${title}”${at}.`;
  } else if (event === "scheduled") {
    if (audience === "resident") text = `${ref}: ${vendor} is scheduled for ${when}. Please make the area accessible.`;
    if (audience === "vendor") text = `${ref}: Visit confirmed for ${when}${at}.`;
    if (audience === "manager") text = `${ref}: “${title}” is scheduled for ${when}${facts.vendorName ? ` with ${vendor}` : ""}.`;
  } else if (event === "rescheduled") {
    if (audience === "resident") text = `${ref}: ${vendor}’s visit for “${title}” moved to ${when}.`;
    if (audience === "vendor") text = `${ref}: Your visit for “${title}”${at} moved to ${when}.`;
    if (audience === "manager") text = `${ref}: “${title}” moved to ${when}.`;
  } else if (event === "cancelled") {
    if (audience === "resident") text = `${ref}: The visit for “${title}” on ${when} was cancelled${noteSuffix}. We are rebooking it.`;
    if (audience === "vendor") text = `${ref}: The visit for “${title}”${at} on ${when} was cancelled${noteSuffix}.`;
    if (audience === "manager") text = `${ref}: The visit for “${title}” on ${when} was cancelled${noteSuffix}.`;
  } else if (event === "en_route") {
    if (audience === "resident") text = `${ref}: ${vendor} is on the way for “${title}”${facts.etaMinutes ? ` (about ${facts.etaMinutes} min)` : ""}.`;
  } else if (event === "completed") {
    if (audience === "resident") {
      text = facts.confirmUrl
        ? `${ref}: ${vendor} marked “${title}” done. Was it fixed? Tell us here: ${facts.confirmUrl}`
        : `${ref}: “${title}” was marked complete.`;
    }
    if (audience === "vendor") text = `${ref}: “${title}” is marked done. Submit your invoice if one is still needed.`;
    if (audience === "manager") text = `${ref}: “${title}” is done and awaiting invoice or approval.`;
    if (audience === "team") text = `${ref}: “${title}”${at} is marked done.`;
  } else if (event === "resident_confirmed") {
    if (audience === "resident") text = `${ref}: Thanks — “${title}” is closed.${facts.ratingUrl ? ` Rate the visit: ${facts.ratingUrl}` : ""}`;
    if (audience === "manager") text = `${ref}: ${facts.residentName?.trim() || "The resident"} confirmed “${title}” is fixed.`;
  } else if (event === "resident_reopened") {
    if (audience === "resident") text = `${ref}: Sorry “${title}” is not fixed. It is reopened and your property manager will follow up.`;
    if (audience === "vendor") text = `${ref}: The resident reports “${title}”${at} is not resolved${noteSuffix}. The manager will follow up.`;
    if (audience === "manager") text = `${ref}: ${facts.residentName?.trim() || "The resident"} says “${title}”${at} is NOT fixed${noteSuffix}. It is reopened.`;
  } else if (event === "auto_closed") {
    if (audience === "resident") text = `${ref}: “${title}” closed automatically. Reply here if it is not fixed.`;
  } else if (event === "rated") {
    const stars = typeof facts.rating === "number" ? `${facts.rating}★` : "a rating";
    if (audience === "vendor") text = `${ref}: ${stars} from the resident on “${title}”${noteSuffix}.`;
    if (audience === "manager") text = `${ref}: ${facts.residentName?.trim() || "The resident"} rated ${vendor} ${stars} on “${title}”${noteSuffix}.`;
  } else if (event === "invoiced") {
    if (audience === "vendor") text = `${ref}: Your invoice for ${money(facts.amountCents)} was received.`;
    if (audience === "manager") text = `${ref}: Invoice received for ${money(facts.amountCents)}. Review and approve it in PropLane.`;
  } else if (event === "invoice_approved") {
    if (audience === "vendor") text = `${ref}: Your ${money(facts.amountCents)} invoice for “${title}” was approved. Payment follows.`;
  } else if (event === "invoice_disputed") {
    if (audience === "vendor") text = `${ref}: Your manager has a question about the ${money(facts.amountCents)} invoice for “${title}”${noteSuffix}. Reply here.`;
  } else if (event === "paid") {
    if (audience === "vendor") text = `${ref}: Payment of ${money(facts.amountCents)} was sent.`;
    if (audience === "manager") text = `${ref}: ${money(facts.amountCents)} was marked paid.`;
  }
  if (!text) return null;
  return { subject: `${ref} · ${title}`, text, smsText: text };
}

export function workOrderDeliveryPolicy(input: {
  now: Date;
  emergency?: boolean;
  recentEventCount: number;
}): { deferSms: boolean; digest: boolean; nextAttemptAt: string | null } {
  return actionDeliveryPolicy({
    now: input.now,
    urgent: input.emergency,
    recentEventCount: input.recentEventCount,
  });
}

/**
 * The inbox refuses a vendor writing to a resident (or the reverse): they are
 * not connected accounts. Copies across that line are sent AS the owning
 * manager instead, under their own event key, so the resident's "was this
 * fixed?" link and the vendor's "not fixed" note actually arrive. Before this
 * the old "marked done" resident notice failed the same way, silently.
 */
async function managerSender(db: SupabaseClient, managerUserId: string): Promise<{ userId: string; email: string; name?: string } | null> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
  const email = String(data?.email ?? "").trim().toLowerCase();
  if (!email) return null;
  return { userId: managerUserId, email, name: String(data?.full_name ?? "").trim() || undefined };
}

type WorkOrderEventInput = {
  eventId: string;
  event: WorkOrderEventType;
  managerUserId: string;
  workOrderId: string;
  senderUserId: string;
  senderEmail: string;
  senderName?: string;
  facts: WorkOrderEventFacts;
  recipients: WorkOrderEventRecipient[];
  occurredAt?: string;
  now?: Date;
  /** Who is acting. Defaults to manager; a vendor or resident actor triggers the cross-party split above. */
  senderAudience?: WorkOrderEventAudience;
};

/**
 * Public entry point. Injects the WS5 team-audience recipient exactly ONCE,
 * before the cross-party split below can recurse — `workOrderEventImpl`'s
 * recursive self-calls go through the impl directly so a re-entry never
 * re-injects and double-posts to the team thread.
 */
export async function workOrderEvent(
  db: SupabaseClient,
  input: WorkOrderEventInput,
): Promise<{ eventId: string; duplicate: boolean; delivered: number; deferred: number; failed: number }> {
  // WS5: "assigned" (accepted) and "completed" are team-visible moments.
  // Centralized here (rather than at each of the ~10 call sites) so no
  // caller needs to resolve team membership itself.
  const needsTeam =
    (input.event === "accepted" || input.event === "completed") &&
    !input.recipients.some((recipient) => recipient.audience === "team");
  const recipients = needsTeam
    ? [...input.recipients, { audience: "team" as const, userId: input.managerUserId }]
    : input.recipients;
  return workOrderEventImpl(db, { ...input, recipients });
}

async function workOrderEventImpl(
  db: SupabaseClient,
  input: WorkOrderEventInput,
): Promise<{ eventId: string; duplicate: boolean; delivered: number; deferred: number; failed: number }> {
  if (input.senderAudience && input.senderAudience !== "manager") {
    const crossParty = input.recipients.filter((recipient) => recipient.audience !== "manager" && recipient.audience !== input.senderAudience);
    if (crossParty.length > 0) {
      const own = input.recipients.filter((recipient) => !crossParty.includes(recipient));
      const manager = await managerSender(db, input.managerUserId);
      const first = await workOrderEventImpl(db, { ...input, recipients: own, senderAudience: undefined });
      if (manager) {
        await workOrderEventImpl(db, {
          ...input,
          eventId: `${input.eventId}:as-manager`,
          senderUserId: manager.userId,
          senderEmail: manager.email,
          senderName: manager.name,
          recipients: crossParty,
          senderAudience: undefined,
          // The webhook already went out with the first half.
          workOrderId: input.workOrderId,
        }).catch(() => undefined);
      }
      return first;
    }
  }
  // An invoice decision with no linked work order has no work-order id to
  // publish; everything else goes out as before.
  if (!input.workOrderId.startsWith("invoice:")) {
    const outbound = outboundWebhook(input.event, input.workOrderId, input.occurredAt);
    // Outbound webhooks. Never throws in here — a webhook problem must not fail
    // the transition that produced it.
    await enqueueWebhookEvent(input.managerUserId, outbound.type, outbound.payload);
  }
  return emitActionEvent(db, {
    eventId: input.eventId,
    domain: "work_order",
    event: input.event,
    managerUserId: input.managerUserId,
    entityId: input.workOrderId,
    category: "maintenance",
    senderUserId: input.senderUserId,
    senderEmail: input.senderEmail,
    senderName: input.senderName,
    payload: {
      reference: input.facts.reference,
      emergency: input.facts.emergency === true,
    },
    recipients: input.recipients.flatMap((recipient) => {
      const rendered = renderWorkOrderEvent(input.event, recipient.audience, input.facts);
      return rendered ? [{ ...recipient, rendered }] : [];
    }),
    urgent: input.facts.emergency,
    occurredAt: input.occurredAt,
    now: input.now,
    templateContext: workOrderTemplateContext(input.facts),
  });
}

/** Placeholder values for a manager-authored template of a work-order message. */
export function workOrderTemplateContext(facts: WorkOrderEventFacts): Record<string, string> {
  return {
    reference: facts.reference ?? "",
    title: facts.title ?? "",
    propertyTitle: facts.propertyLabel ?? "",
    whenLabel: facts.scheduledFor ?? "",
    vendorName: facts.vendorName ?? "",
    residentName: facts.residentName ?? "",
    amountLabel: typeof facts.amountCents === "number" ? money(facts.amountCents) : "",
    accessInstructions: facts.accessInstructions ?? "",
    residentContact: facts.residentContact ?? "",
    responsePromise: facts.responsePromise ?? "",
    emergencyPhone: facts.emergencyPhone ?? "",
    expiresLabel: facts.expiresLabel ?? "",
    note: facts.note ?? "",
    confirmUrl: facts.confirmUrl ?? "",
    ratingUrl: facts.ratingUrl ?? "",
    rating: typeof facts.rating === "number" ? String(facts.rating) : "",
    url: facts.url ?? "",
  };
}
