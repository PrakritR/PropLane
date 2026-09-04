import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { emitActionEvent, type ActionEventAudience, type ActionEventRendered } from "@/lib/action-events.server";

export const ACTION_EVENT_CATALOG = {
  payment: ["charge_created", "payment_processing", "payment_received", "payment_failed", "payment_refunded"],
  lease: ["lease_created", "lease_sent", "lease_signed", "lease_voided"],
  work_order: ["created", "vendor_offered", "accepted", "scheduled", "completed", "invoiced", "paid"],
} as const;

export type PaymentActionEvent = (typeof ACTION_EVENT_CATALOG.payment)[number];
export type LeaseActionEvent = (typeof ACTION_EVENT_CATALOG.lease)[number];

type PaymentFacts = { title: string; amountLabel: string; propertyLabel?: string };
type LeaseFacts = { residentName: string; propertyLabel?: string; status?: string };

export function renderPaymentActionEvent(
  event: PaymentActionEvent,
  audience: ActionEventAudience,
  facts: PaymentFacts,
): ActionEventRendered | null {
  const title = facts.title.trim() || "Charge";
  const amount = facts.amountLabel.trim() || "the recorded amount";
  const at = facts.propertyLabel?.trim() ? ` at ${facts.propertyLabel.trim()}` : "";
  let text: string | null = null;
  if (event === "charge_created" && audience === "resident") text = `A new ${amount} charge for “${title}”${at} was added.`;
  if (event === "charge_created" && audience === "manager") text = `The ${amount} charge for “${title}”${at} was created.`;
  if (event === "payment_processing" && audience === "resident") text = `Your ${amount} payment for “${title}” is processing.`;
  if (event === "payment_received" && audience === "resident") text = `Your ${amount} payment for “${title}” was received.`;
  if (event === "payment_received" && audience === "manager") text = `${amount} was received for “${title}”${at}.`;
  if (event === "payment_failed" && audience === "resident") text = `Your payment for “${title}” could not be completed. Review Payments for next steps.`;
  if (event === "payment_failed" && audience === "manager") text = `Payment failed for “${title}”${at}.`;
  if (event === "payment_refunded" && audience === "resident") text = `${amount} for “${title}” was refunded.`;
  if (event === "payment_refunded" && audience === "manager") text = `${amount} for “${title}”${at} was refunded.`;
  return text ? { subject: `${title} · Payment update`, text, smsText: text } : null;
}

export function renderLeaseActionEvent(
  event: LeaseActionEvent,
  audience: ActionEventAudience,
  facts: LeaseFacts,
): ActionEventRendered | null {
  const resident = facts.residentName.trim() || "Resident";
  const at = facts.propertyLabel?.trim() ? ` for ${facts.propertyLabel.trim()}` : "";
  let text: string | null = null;
  if (event === "lease_created" && audience === "resident") text = `A lease${at} was created for you. You can review it in PropLane.`;
  if (event === "lease_created" && audience === "manager") text = `A lease${at} was created for ${resident}.`;
  if (event === "lease_sent" && audience === "resident") text = `Your lease${at} is ready to review and sign.`;
  if (event === "lease_sent" && audience === "manager") text = `${resident} was sent the lease${at}.`;
  if (event === "lease_signed" && audience === "resident") text = `Your lease${at} is fully signed. The executed copy is available in Documents.`;
  if (event === "lease_signed" && audience === "manager") text = `${resident}’s lease${at} is fully signed.`;
  if (event === "lease_voided" && audience === "resident") text = `Your lease${at} was voided. Contact your property manager with questions.`;
  if (event === "lease_voided" && audience === "manager") text = `${resident}’s lease${at} was voided.`;
  return text ? { subject: `${resident} · Lease update`, text, smsText: text } : null;
}

async function managerSender(db: SupabaseClient, managerUserId: string) {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
  return {
    userId: managerUserId,
    email: String(data?.email ?? "").trim().toLowerCase(),
    name: String(data?.full_name ?? "").trim() || "PropLane Portal",
  };
}

export function paymentEventForTransition(previousStatus: string | null, nextStatus: string): PaymentActionEvent | null {
  if (!previousStatus) return "charge_created";
  if (previousStatus === nextStatus) return null;
  if (nextStatus === "processing") return "payment_processing";
  if (nextStatus === "paid") return "payment_received";
  if (nextStatus === "failed") return "payment_failed";
  if (nextStatus === "refunded") return "payment_refunded";
  return null;
}

export async function emitHouseholdChargeTransition(
  db: SupabaseClient,
  input: { managerUserId: string; previousStatus: string | null; charge: HouseholdCharge; transitionId?: string },
): Promise<void> {
  const event = paymentEventForTransition(input.previousStatus, input.charge.status);
  if (!event || !input.managerUserId) return;
  const sender = await managerSender(db, input.managerUserId);
  if (!sender.email) return;
  const facts: PaymentFacts = {
    title: input.charge.title || "Charge",
    amountLabel: input.charge.amountLabel || input.charge.balanceLabel || "",
    propertyLabel: input.charge.propertyLabel || undefined,
  };
  const audiences: Array<{ audience: ActionEventAudience; userId?: string; email?: string }> = [
    { audience: "resident", userId: input.charge.residentUserId ?? undefined, email: input.charge.residentEmail || undefined },
    { audience: "manager", userId: input.managerUserId },
  ];
  await emitActionEvent(db, {
    eventId: input.transitionId || `${input.charge.id}:${event}:${input.charge.paidAt || input.charge.createdAt || input.charge.status}`,
    domain: "payment",
    event,
    managerUserId: input.managerUserId,
    entityId: input.charge.id,
    category: "payments",
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    payload: { status: input.charge.status, kind: input.charge.kind, propertyId: input.charge.propertyId },
    recipients: audiences.flatMap((recipient) => {
      const rendered = renderPaymentActionEvent(event, recipient.audience, facts);
      return rendered ? [{ ...recipient, rendered }] : [];
    }),
  });
}

export function leaseEventForTransition(previous: LeasePipelineRow | null, next: LeasePipelineRow): LeaseActionEvent | null {
  if (!previous) return "lease_created";
  if (!previous.sentToResidentAt && next.sentToResidentAt) return "lease_sent";
  if (!previous.fullySignedAt && next.fullySignedAt) return "lease_signed";
  if (!previous.voidedAt && next.voidedAt) return "lease_voided";
  return null;
}

export async function emitLeaseTransition(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    previous: LeasePipelineRow | null;
    lease: LeasePipelineRow;
    actor: { userId: string; email: string; name?: string };
  },
): Promise<void> {
  const event = leaseEventForTransition(input.previous, input.lease);
  if (!event) return;
  const facts: LeaseFacts = {
    residentName: input.lease.residentName || "Resident",
    propertyLabel: input.lease.unit || input.lease.roomChoice || undefined,
    status: input.lease.status,
  };
  const audiences: Array<{ audience: ActionEventAudience; userId?: string; email?: string }> = [
    { audience: "resident", userId: input.lease.residentUserId ?? undefined, email: input.lease.residentEmail || undefined },
    { audience: "manager", userId: input.managerUserId },
  ];
  const marker = event === "lease_sent" ? input.lease.sentToResidentAt : event === "lease_signed" ? input.lease.fullySignedAt : event === "lease_voided" ? input.lease.voidedAt : input.lease.updatedAtIso;
  await emitActionEvent(db, {
    eventId: `${input.lease.id}:${event}:${marker || event}`,
    domain: "lease",
    event,
    managerUserId: input.managerUserId,
    entityId: input.lease.id,
    category: "leases",
    senderUserId: input.actor.userId,
    senderEmail: input.actor.email,
    senderName: input.actor.name,
    payload: { status: input.lease.status, propertyId: input.lease.propertyId },
    recipients: audiences.flatMap((recipient) => {
      const rendered = renderLeaseActionEvent(event, recipient.audience, facts);
      return rendered ? [{ ...recipient, rendered }] : [];
    }),
  });
}
