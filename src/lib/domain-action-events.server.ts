import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import { residentHasSignedLease, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { emitActionEvent, type ActionEventAudience, type ActionEventRendered } from "@/lib/action-events.server";

export const ACTION_EVENT_CATALOG = {
  payment: ["charge_created", "payment_processing", "payment_received", "payment_failed", "payment_refunded"],
  lease: [
    "lease_created",
    "lease_sent",
    // The two one-sided signature steps. A lease is signed by one party and
    // then waits on the other, sometimes for days, and neither wait used to
    // notify anybody: the resident signed into silence and the manager had no
    // way to learn a countersignature was owed except by opening the tab.
    "lease_signed_by_resident",
    "lease_countersigned",
    "lease_signed",
    "lease_voided",
  ],
  work_order: ["created", "vendor_offered", "accepted", "scheduled", "completed", "invoiced", "paid"],
  application: [
    "application_submitted",
    "application_approved",
    "application_declined",
    "application_withdrawn",
  ],
  // Add-on services (parking, storage, the resident-purchasable offerings) are a
  // SEPARATE model from maintenance work orders and keep their own events, the
  // same way they keep their own table and tab.
  service_request: [
    "service_request_submitted",
    "service_request_approved",
    "service_request_denied",
    "service_request_returned",
  ],
} as const;

export type PaymentActionEvent = (typeof ACTION_EVENT_CATALOG.payment)[number];
export type LeaseActionEvent = (typeof ACTION_EVENT_CATALOG.lease)[number];
export type ApplicationActionEvent = (typeof ACTION_EVENT_CATALOG.application)[number];
export type ServiceRequestActionEvent = (typeof ACTION_EVENT_CATALOG.service_request)[number];

type PaymentFacts = { title: string; amountLabel: string; propertyLabel?: string };
type LeaseFacts = { residentName: string; propertyLabel?: string; status?: string };
type ApplicationFacts = { applicantName: string; propertyLabel?: string };
type ServiceRequestFacts = { offerName: string; residentName: string; priceLabel?: string };

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
  if (event === "lease_signed_by_resident" && audience === "resident")
    text = `Thanks — your lease${at} is signed. It now goes to your property manager to countersign, and you will hear from us when it is fully executed.`;
  if (event === "lease_signed_by_resident" && audience === "manager")
    text = `${resident} signed the lease${at}. It is waiting on your countersignature.`;
  if (event === "lease_countersigned" && audience === "resident")
    text = `Your property manager signed the lease${at}. It is waiting on your signature.`;
  if (event === "lease_countersigned" && audience === "manager")
    text = `You signed the lease${at}. It is waiting on ${resident}.`;
  if (event === "lease_signed" && audience === "resident") text = `Your lease${at} is fully signed. The executed copy is available in Documents.`;
  if (event === "lease_signed" && audience === "manager") text = `${resident}’s lease${at} is fully signed.`;
  if (event === "lease_voided" && audience === "resident") text = `Your lease${at} was voided. Contact your property manager with questions.`;
  if (event === "lease_voided" && audience === "manager") text = `${resident}’s lease${at} was voided.`;
  return text ? { subject: `${resident} · Lease update`, text, smsText: text } : null;
}

export function renderApplicationActionEvent(
  event: ApplicationActionEvent,
  audience: ActionEventAudience,
  facts: ApplicationFacts,
): ActionEventRendered | null {
  const applicant = facts.applicantName.trim() || "An applicant";
  const at = facts.propertyLabel?.trim() ? ` for ${facts.propertyLabel.trim()}` : "";
  let text: string | null = null;
  if (event === "application_submitted" && audience === "resident")
    text = `We received your application${at}. Your property manager will review it and you will hear back here.`;
  if (event === "application_submitted" && audience === "manager")
    text = `${applicant} submitted an application${at}.`;
  if (event === "application_approved" && audience === "resident")
    text = `Good news — your application${at} was approved. Your lease and payments are now open in PropLane.`;
  if (event === "application_approved" && audience === "manager")
    text = `You approved ${applicant}'s application${at}.`;
  if (event === "application_declined" && audience === "resident")
    // Deliberately gives no reason. Adverse-action reasoning is a regulated
    // disclosure the manager sends deliberately, never an automated line.
    text = `Your application${at} was not approved. Your property manager can tell you more.`;
  if (event === "application_declined" && audience === "manager")
    text = `You declined ${applicant}'s application${at}.`;
  if (event === "application_withdrawn" && audience === "manager")
    text = `${applicant} withdrew their application${at}.`;
  if (event === "application_withdrawn" && audience === "resident")
    text = `Your application${at} was withdrawn. You can apply again at any time.`;
  return text ? { subject: `${applicant} · Application update`, text, smsText: text } : null;
}

type ApplicationRowFacts = {
  id: string;
  name?: string | null;
  email?: string | null;
  property?: string | null;
  bucket?: string | null;
  withdrawnAt?: string | null;
  residentUserId?: string | null;
  updatedAtIso?: string | null;
};

export function applicationEventForTransition(
  previous: ApplicationRowFacts | null,
  next: ApplicationRowFacts,
): ApplicationActionEvent | null {
  const wasWithdrawn = Boolean(previous?.withdrawnAt);
  const isWithdrawn = Boolean(next.withdrawnAt);
  if (!wasWithdrawn && isWithdrawn) return "application_withdrawn";
  // A withdrawn application is reversible and keeps its bucket, so a bucket
  // comparison across the withdraw/restore boundary is not a decision anyone
  // made. Only a live row's bucket move is a manager acting on it.
  if (isWithdrawn) return null;
  const previousBucket = String(previous?.bucket ?? "").trim().toLowerCase();
  const nextBucket = String(next.bucket ?? "").trim().toLowerCase();
  if (!previous) return nextBucket === "pending" ? "application_submitted" : null;
  if (previousBucket === nextBucket) return null;
  if (nextBucket === "approved") return "application_approved";
  if (nextBucket === "rejected") return "application_declined";
  return null;
}

/**
 * Application lifecycle on the shared bus.
 *
 * The manager's own "new application" notice is NOT emitted here: it already
 * exists in `application-submitted-notification.server`, and that path resolves
 * property-scoped CO-MANAGER recipients, which a single `managerUserId` on this
 * bus cannot reproduce. Emitting both would notify the owner twice. What was
 * missing is every other side of it — the applicant heard nothing at all, on
 * submit or on the decision — so those are what this adds.
 */
export async function emitApplicationTransition(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    previous: ApplicationRowFacts | null;
    application: ApplicationRowFacts;
    /**
     * Who acted. Omitted on the GUEST submit path, where there is no signed-in
     * user at all — the sender then falls back to the owning manager, which is
     * who the applicant's confirmation should appear to come from anyway.
     */
    actor?: { userId: string; email: string; name?: string };
  },
): Promise<void> {
  const event = applicationEventForTransition(input.previous, input.application);
  if (!event || !input.managerUserId) return;
  const actor =
    input.actor?.userId && input.actor.email
      ? input.actor
      : await managerSender(db, input.managerUserId);
  if (!actor.email) return;
  const facts: ApplicationFacts = {
    applicantName: input.application.name?.trim() || input.application.email?.trim() || "An applicant",
    propertyLabel: input.application.property?.trim() || undefined,
  };
  const audiences: Array<{ audience: ActionEventAudience; userId?: string; email?: string }> = [
    {
      audience: "resident",
      userId: input.application.residentUserId ?? undefined,
      email: input.application.email?.trim() || undefined,
    },
  ];
  // The submit notice to the manager is owned elsewhere (see above); every other
  // transition is one this bus is the only sender of.
  if (event !== "application_submitted") {
    audiences.push({ audience: "manager", userId: input.managerUserId });
  }
  const marker =
    event === "application_withdrawn"
      ? input.application.withdrawnAt
      : `${input.application.bucket ?? ""}`;
  await emitActionEvent(db, {
    eventId: `${input.application.id}:${event}:${marker || event}`,
    domain: "application",
    event,
    managerUserId: input.managerUserId,
    entityId: input.application.id,
    category: "applications",
    senderUserId: actor.userId,
    senderEmail: actor.email,
    senderName: actor.name,
    payload: { bucket: input.application.bucket ?? null },
    recipients: audiences.flatMap((recipient) => {
      const rendered = renderApplicationActionEvent(event, recipient.audience, facts);
      return rendered ? [{ ...recipient, rendered }] : [];
    }),
  });
}

export function renderServiceRequestActionEvent(
  event: ServiceRequestActionEvent,
  audience: ActionEventAudience,
  facts: ServiceRequestFacts,
): ActionEventRendered | null {
  const offer = facts.offerName.trim() || "Add-on service";
  const resident = facts.residentName.trim() || "A resident";
  const price = facts.priceLabel?.trim() ? ` (${facts.priceLabel.trim()})` : "";
  let text: string | null = null;
  if (event === "service_request_submitted" && audience === "resident")
    text = `We received your request for “${offer}”${price}. Your property manager will review it.`;
  if (event === "service_request_submitted" && audience === "manager")
    text = `${resident} requested “${offer}”${price}.`;
  if (event === "service_request_approved" && audience === "resident")
    text = `Your request for “${offer}” was approved. Any amount due is in Payments.`;
  if (event === "service_request_approved" && audience === "manager")
    text = `You approved “${offer}” for ${resident}.`;
  if (event === "service_request_denied" && audience === "resident")
    text = `Your request for “${offer}” was not approved. Your property manager can tell you more.`;
  if (event === "service_request_denied" && audience === "manager")
    text = `You denied “${offer}” for ${resident}.`;
  if (event === "service_request_returned" && audience === "resident")
    text = `“${offer}” is marked returned. Any refundable deposit will be settled in Payments.`;
  if (event === "service_request_returned" && audience === "manager")
    text = `${resident} returned “${offer}”.`;
  return text ? { subject: `${offer} · Add-on service update`, text, smsText: text } : null;
}

export function serviceRequestEventForTransition(
  previousStatus: string | null,
  nextStatus: string,
): ServiceRequestActionEvent | null {
  const next = nextStatus.trim().toLowerCase();
  if (!previousStatus) return next === "pending" ? "service_request_submitted" : null;
  if (previousStatus.trim().toLowerCase() === next) return null;
  if (next === "approved") return "service_request_approved";
  if (next === "denied") return "service_request_denied";
  if (next === "returned") return "service_request_returned";
  return null;
}

/**
 * Add-on service lifecycle on the shared bus.
 *
 * As with applications, the manager's CREATE notice stays with
 * `notifyManagerOfResidentFiledItem`, which resolves property-scoped
 * co-managers. What was missing is the resident's own side: a resident filed a
 * request and got no acknowledgement at all, and neither party heard anything
 * when it was later approved, denied, or returned.
 */
export async function emitServiceRequestTransition(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    previousStatus: string | null;
    request: ServiceRequest;
    actor?: { userId: string; email: string; name?: string };
  },
): Promise<void> {
  const event = serviceRequestEventForTransition(input.previousStatus, input.request.status);
  if (!event || !input.managerUserId) return;
  const actor =
    input.actor?.userId && input.actor.email
      ? input.actor
      : await managerSender(db, input.managerUserId);
  if (!actor.email) return;
  const facts: ServiceRequestFacts = {
    offerName: input.request.offerName || "Add-on service",
    residentName: input.request.residentName || input.request.residentEmail || "A resident",
    priceLabel: input.request.price || undefined,
  };
  const audiences: Array<{ audience: ActionEventAudience; userId?: string; email?: string }> = [
    { audience: "resident", email: input.request.residentEmail?.trim() || undefined },
  ];
  if (event !== "service_request_submitted") {
    audiences.push({ audience: "manager", userId: input.managerUserId });
  }
  await emitActionEvent(db, {
    eventId: `${input.request.id}:${event}`,
    domain: "service_request",
    event,
    managerUserId: input.managerUserId,
    entityId: input.request.id,
    category: "maintenance",
    senderUserId: actor.userId,
    senderEmail: actor.email,
    senderName: actor.name,
    payload: { status: input.request.status, propertyId: input.request.propertyId },
    recipients: audiences.flatMap((recipient) => {
      const rendered = renderServiceRequestActionEvent(event, recipient.audience, facts);
      return rendered ? [{ ...recipient, rendered }] : [];
    }),
  });
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

function managerHasSignedLease(row: LeasePipelineRow): boolean {
  return Boolean(row.managerSignature?.name && row.managerSignature?.signedAtIso);
}

export function leaseEventForTransition(previous: LeasePipelineRow | null, next: LeasePipelineRow): LeaseActionEvent | null {
  if (!previous) return "lease_created";
  if (!previous.sentToResidentAt && next.sentToResidentAt) return "lease_sent";
  // Full execution outranks either half of it. One save can carry the second
  // signature AND `fullySignedAt`, and "your lease is fully signed" is the
  // message both parties want then — not "it is waiting on the other one".
  if (!previous.fullySignedAt && next.fullySignedAt) return "lease_signed";
  if (!next.fullySignedAt) {
    if (!residentHasSignedLease(previous) && residentHasSignedLease(next)) return "lease_signed_by_resident";
    if (!managerHasSignedLease(previous) && managerHasSignedLease(next)) return "lease_countersigned";
  }
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
  // The eventId is the idempotency key, so each event needs a marker that moves
  // only when THAT event happens. Reusing `updatedAtIso` for a signature step
  // would mint a fresh key on every unrelated save and re-notify both parties.
  const marker =
    event === "lease_sent"
      ? input.lease.sentToResidentAt
      : event === "lease_signed"
        ? input.lease.fullySignedAt
        : event === "lease_signed_by_resident"
          ? input.lease.residentSignature?.signedAtIso || input.lease.signedAtIso
          : event === "lease_countersigned"
            ? input.lease.managerSignature?.signedAtIso
            : event === "lease_voided"
              ? input.lease.voidedAt
              : input.lease.updatedAtIso;
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
