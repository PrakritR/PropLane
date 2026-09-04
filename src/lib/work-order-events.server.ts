import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { actionDeliveryPolicy, emitActionEvent } from "@/lib/action-events.server";

export type WorkOrderEventType =
  | "created"
  | "vendor_offered"
  | "accepted"
  | "scheduled"
  | "completed"
  | "invoiced"
  | "paid";
export type WorkOrderEventAudience = "manager" | "resident" | "vendor";

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

  if (event === "created") {
    text = audience === "manager" ? `${ref}: New work order “${title}”${at}. Review and assign it.` : audience === "resident" ? `${ref}: Your maintenance request “${title}” was logged.` : null;
  } else if (event === "vendor_offered") {
    text = audience === "vendor" ? `${ref}: You have a new work-order offer for “${title}”${at}. Review it and respond.` : audience === "manager" ? `${ref}: Offer sent to ${facts.offerCount ?? 1} vendor${facts.offerCount === 1 ? "" : "s"}.` : null;
  } else if (event === "accepted") {
    if (audience === "resident") text = `${ref}: ${vendor} is booked for ${when}.`;
    if (audience === "vendor") text = `${ref}: Your offer was accepted for “${title}”${at}. Visit: ${when}.${facts.accessInstructions ? ` Access: ${facts.accessInstructions}` : ""}${facts.residentContact ? ` Resident contact: ${facts.residentContact}` : ""}`;
    if (audience === "manager") text = `${ref}: ${vendor} accepted “${title}” for ${money(facts.amountCents)}.`;
  } else if (event === "scheduled") {
    if (audience === "resident") text = `${ref}: ${vendor} is scheduled for ${when}. Please make the area accessible.`;
    if (audience === "vendor") text = `${ref}: Visit confirmed for ${when}${at}.`;
  } else if (event === "completed") {
    if (audience === "resident") text = `${ref}: “${title}” was marked complete. Is the issue resolved? Reply YES or NO.`;
    if (audience === "vendor") text = `${ref}: “${title}” is marked done. Submit your invoice if one is still needed.`;
    if (audience === "manager") text = `${ref}: “${title}” is done and awaiting invoice or approval.`;
  } else if (event === "invoiced") {
    if (audience === "vendor") text = `${ref}: Your invoice for ${money(facts.amountCents)} was received.`;
    if (audience === "manager") text = `${ref}: Invoice received for ${money(facts.amountCents)}. Review and approve it in PropLane.`;
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

export async function workOrderEvent(
  db: SupabaseClient,
  input: {
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
  },
): Promise<{ eventId: string; duplicate: boolean; delivered: number; deferred: number; failed: number }> {
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
  });
}
