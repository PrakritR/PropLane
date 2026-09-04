import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isWithinQuietHours } from "@/lib/sms/number-registration-policy";

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
  if (input.emergency) return { deferSms: false, digest: false, nextAttemptAt: null };
  const digest = input.recentEventCount >= 4;
  const quiet = isWithinQuietHours(input.now);
  if (!quiet && !digest) return { deferSms: false, digest: false, nextAttemptAt: null };
  const next = new Date(input.now);
  if (quiet) {
    // Walk to the first non-quiet hour in the same canonical timezone used by
    // the transport gate. This remains DST-safe without persisting local times.
    next.setMinutes(0, 0, 0);
    do next.setHours(next.getHours() + 1); while (isWithinQuietHours(next));
  } else {
    next.setMinutes(next.getMinutes() + 10, 0, 0);
  }
  return { deferSms: true, digest, nextAttemptAt: next.toISOString() };
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
  const eventKey = input.eventId.trim();
  if (!eventKey) throw new Error("workOrderEvent requires an idempotency eventId");
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const { data: inserted, error: insertError } = await db
    .from("work_order_events")
    .upsert({ event_key: eventKey, manager_user_id: input.managerUserId, work_order_id: input.workOrderId, event_type: input.event, occurred_at: occurredAt, payload: input.facts }, { onConflict: "event_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (insertError) throw new Error(`Could not record work-order event: ${insertError.message}`);
  let eventRow = inserted as { id: string } | null;
  const duplicate = !eventRow;
  if (!eventRow) {
    const { data, error } = await db.from("work_order_events").select("id").eq("event_key", eventKey).maybeSingle();
    if (error || !data) throw new Error(`Could not resolve work-order event: ${error?.message ?? "missing event"}`);
    eventRow = data as { id: string };
  }

  let delivered = 0;
  let deferred = 0;
  let failed = 0;
  for (const recipient of input.recipients) {
    const rendered = renderWorkOrderEvent(input.event, recipient.audience, input.facts);
    const recipientKey = recipient.userId?.trim() || recipient.email?.trim().toLowerCase() || "";
    if (!rendered || !recipientKey) continue;
    const since = new Date((input.now ?? new Date()).getTime() - 10 * 60_000).toISOString();
    const { count } = await db.from("work_order_event_deliveries").select("id", { count: "exact", head: true }).eq("recipient_key", recipientKey).gte("created_at", since);
    const policy = workOrderDeliveryPolicy({ now: input.now ?? new Date(), emergency: input.facts.emergency, recentEventCount: count ?? 0 });
    const deliveryStatus = policy.deferSms ? (policy.digest ? "digested" : "deferred") : "pending";
    const { data: delivery } = await db.from("work_order_event_deliveries").upsert({ event_id: eventRow.id, audience: recipient.audience, recipient_key: recipientKey, recipient_user_id: recipient.userId ?? null, recipient_email: recipient.email?.trim().toLowerCase() ?? null, status: deliveryStatus, next_attempt_at: policy.nextAttemptAt, rendered }, { onConflict: "event_id,audience,recipient_key", ignoreDuplicates: true }).select("id,status").maybeSingle();
    if (!delivery) continue;
    const result = await deliverPortalInboxMessage(db, {
      senderUserId: input.senderUserId,
      senderEmail: input.senderEmail,
      fromName: input.senderName?.trim() || "PropLane Portal",
      subject: rendered.subject,
      text: policy.digest ? `Several updates were recorded for ${input.facts.reference}. Open PropLane for the latest status.` : rendered.text,
      smsText: rendered.smsText,
      toUserIds: recipient.userId ? [recipient.userId] : undefined,
      toEmails: recipient.email ? [recipient.email] : undefined,
      eventCategory: "maintenance",
      suppressSms: policy.deferSms,
    }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "Delivery failed" }));
    if (result.ok) {
      await db.from("work_order_event_deliveries").update({ status: policy.deferSms ? deliveryStatus : "delivered", attempts: 1, delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", delivery.id);
      if (policy.deferSms) deferred++;
      else delivered++;
    } else {
      await db.from("work_order_event_deliveries").update({ status: "failed", attempts: 1, last_error: result.error, next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(), updated_at: new Date().toISOString() }).eq("id", delivery.id);
      failed++;
    }
  }
  await db.from("work_order_events").update({ processed_at: new Date().toISOString() }).eq("id", eventRow.id);
  return { eventId: eventKey, duplicate, delivered, deferred, failed };
}
