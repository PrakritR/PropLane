/**
 * "Messages sent automatically" — the manager's per-event switch and template
 * for every state-change message the action-event bus sends.
 *
 * Reminders (the timed half of the spine) already had a Settings row each;
 * event messages ("your lease is fully signed", "the vendor accepted") had no
 * control at all — a manager could neither see nor edit what went out when a
 * lease was signed. This is that control: one entry per
 * `${domain}:${event}:${audience}`, absent meaning "on, default copy".
 *
 * Stored in `manager_automation_settings.row_data.automatedMessages`, beside
 * `reminderRules` — no migration, no second settings store. Pure so the
 * Settings UI can import it in the browser; `emitActionEvent` applies it.
 */
import { fillReminderTemplate } from "@/lib/reminders/subject-settings-meta";

export type AutomatedMessageAudience = "manager" | "resident" | "vendor";

export type AutomatedMessageSetting = {
  enabled: boolean;
  template?: { subject: string; body: string };
};

export type AutomatedMessageSettings = Record<string, AutomatedMessageSetting>;

export function automatedMessageKey(domain: string, event: string, audience: AutomatedMessageAudience): string {
  return `${domain}:${event}:${audience}`;
}

/** The catalogue: which events exist, in which area they are shown, and who hears each. */
export type AutomatedMessageCatalogEntry = {
  domain: string;
  event: string;
  /** The Settings tab that owns the row. */
  area: "services" | "lease" | "payments" | "applications" | "tours" | "inspections" | "tasks" | "communication";
  label: string;
  audiences: AutomatedMessageAudience[];
  /** Placeholder names a template may use for this event. */
  placeholders: string[];
};

export const AUTOMATED_MESSAGE_CATALOG: AutomatedMessageCatalogEntry[] = [
  // ---- Services: maintenance work orders ----
  { domain: "work_order", event: "created", area: "services", label: "Request filed", audiences: ["resident", "manager"], placeholders: ["residentName", "title", "propertyTitle", "responsePromise", "url"] },
  { domain: "work_order", event: "vendor_offered", area: "services", label: "Offer sent to vendors", audiences: ["vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "expiresLabel", "url"] },
  { domain: "work_order", event: "offer_expiring", area: "services", label: "Offer expiring soon", audiences: ["vendor"], placeholders: ["vendorName", "title", "propertyTitle", "expiresLabel", "url"] },
  { domain: "work_order", event: "offer_expired", area: "services", label: "Offer expired", audiences: ["vendor", "manager"], placeholders: ["title", "propertyTitle", "url"] },
  { domain: "work_order", event: "offer_filled", area: "services", label: "Offer filled by another vendor", audiences: ["vendor"], placeholders: ["title", "propertyTitle"] },
  { domain: "work_order", event: "vendor_declined", area: "services", label: "Vendor declined", audiences: ["manager"], placeholders: ["vendorName", "title", "propertyTitle", "note", "url"] },
  { domain: "work_order", event: "accepted", area: "services", label: "Vendor accepted", audiences: ["resident", "vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "whenLabel", "amountLabel", "accessInstructions", "residentContact"] },
  { domain: "work_order", event: "scheduled", area: "services", label: "Visit scheduled", audiences: ["resident", "vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "whenLabel"] },
  { domain: "work_order", event: "rescheduled", area: "services", label: "Visit rescheduled", audiences: ["resident", "vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "whenLabel"] },
  { domain: "work_order", event: "cancelled", area: "services", label: "Visit cancelled", audiences: ["resident", "vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "note"] },
  { domain: "work_order", event: "en_route", area: "services", label: "Vendor on the way", audiences: ["resident"], placeholders: ["vendorName", "title", "propertyTitle"] },
  { domain: "work_order", event: "completed", area: "services", label: "Marked done", audiences: ["resident", "vendor", "manager"], placeholders: ["vendorName", "title", "propertyTitle", "confirmUrl"] },
  { domain: "work_order", event: "resident_confirmed", area: "services", label: "Resident confirmed the fix", audiences: ["resident", "manager"], placeholders: ["residentName", "title", "propertyTitle", "ratingUrl"] },
  { domain: "work_order", event: "resident_reopened", area: "services", label: "Resident says not fixed", audiences: ["resident", "vendor", "manager"], placeholders: ["residentName", "title", "propertyTitle", "note", "url"] },
  { domain: "work_order", event: "auto_closed", area: "services", label: "Closed after no reply", audiences: ["resident"], placeholders: ["title", "propertyTitle"] },
  { domain: "work_order", event: "rated", area: "services", label: "Rating received", audiences: ["vendor", "manager"], placeholders: ["residentName", "vendorName", "title", "rating"] },
  { domain: "work_order", event: "invoiced", area: "services", label: "Invoice received", audiences: ["vendor", "manager"], placeholders: ["vendorName", "title", "amountLabel", "url"] },
  { domain: "work_order", event: "invoice_approved", area: "services", label: "Invoice approved", audiences: ["vendor"], placeholders: ["title", "amountLabel"] },
  { domain: "work_order", event: "invoice_disputed", area: "services", label: "Invoice disputed", audiences: ["vendor"], placeholders: ["title", "amountLabel", "note"] },
  { domain: "work_order", event: "paid", area: "services", label: "Paid", audiences: ["vendor", "manager"], placeholders: ["title", "amountLabel"] },
  // ---- Services: add-ons ----
  { domain: "service_request", event: "service_request_submitted", area: "services", label: "Add-on request submitted", audiences: ["resident", "manager"], placeholders: ["residentName", "offerName", "priceLabel"] },
  { domain: "service_request", event: "service_request_approved", area: "services", label: "Add-on request approved", audiences: ["resident", "manager"], placeholders: ["residentName", "offerName", "priceLabel"] },
  { domain: "service_request", event: "service_request_denied", area: "services", label: "Add-on request denied", audiences: ["resident", "manager"], placeholders: ["residentName", "offerName"] },
  { domain: "service_request", event: "service_request_returned", area: "services", label: "Add-on returned", audiences: ["resident", "manager"], placeholders: ["residentName", "offerName"] },
  // ---- Leases ----
  { domain: "lease", event: "lease_created", area: "lease", label: "Lease created", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "url"] },
  { domain: "lease", event: "lease_sent", area: "lease", label: "Lease sent for signature", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "url"] },
  { domain: "lease", event: "lease_signed_by_resident", area: "lease", label: "Signed by resident", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "url"] },
  { domain: "lease", event: "lease_countersigned", area: "lease", label: "Countersigned", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "url"] },
  { domain: "lease", event: "lease_signed", area: "lease", label: "Fully signed", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "url"] },
  { domain: "lease", event: "lease_voided", area: "lease", label: "Voided", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle"] },
  { domain: "lease", event: "move_out_notice", area: "lease", label: "Move-out date set", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "moveOutLabel"] },
  { domain: "lease", event: "amendment_sent", area: "lease", label: "Lease extended", audiences: ["resident", "manager"], placeholders: ["residentName", "propertyTitle", "leaseEndLabel"] },
  // ---- Payments ----
  { domain: "payment", event: "charge_created", area: "payments", label: "Charge created", audiences: ["resident", "manager"], placeholders: ["title", "amountLabel", "propertyTitle"] },
  { domain: "payment", event: "payment_processing", area: "payments", label: "Payment processing", audiences: ["resident"], placeholders: ["title", "amountLabel"] },
  { domain: "payment", event: "payment_received", area: "payments", label: "Payment received", audiences: ["resident", "manager"], placeholders: ["title", "amountLabel", "propertyTitle"] },
  { domain: "payment", event: "partial_received", area: "payments", label: "Partial payment", audiences: ["resident", "manager"], placeholders: ["title", "amountLabel", "balanceLabel", "dueDateLabel"] },
  { domain: "payment", event: "payment_failed", area: "payments", label: "Payment failed", audiences: ["resident", "manager"], placeholders: ["title", "propertyTitle"] },
  { domain: "payment", event: "payment_refunded", area: "payments", label: "Refunded", audiences: ["resident", "manager"], placeholders: ["title", "amountLabel"] },
  { domain: "payment", event: "late_fee_applied", area: "payments", label: "Late fee applied", audiences: ["resident", "manager"], placeholders: ["title", "amountLabel"] },
  { domain: "payment", event: "deposit_received", area: "payments", label: "Deposit received", audiences: ["resident", "manager"], placeholders: ["amountLabel", "propertyTitle"] },
  // ---- Applications ----
  { domain: "application", event: "application_submitted", area: "applications", label: "Submitted", audiences: ["resident"], placeholders: ["applicantName", "propertyTitle", "responsePromise"] },
  { domain: "application", event: "fee_paid", area: "applications", label: "Application fee paid", audiences: ["resident", "manager"], placeholders: ["applicantName", "propertyTitle", "amountLabel"] },
  { domain: "application", event: "documents_requested", area: "applications", label: "Documents requested", audiences: ["resident"], placeholders: ["applicantName", "propertyTitle", "documents", "url"] },
  { domain: "application", event: "documents_received", area: "applications", label: "Documents received", audiences: ["manager"], placeholders: ["applicantName", "propertyTitle", "documents"] },
  { domain: "application", event: "screening_complete", area: "applications", label: "Screening complete", audiences: ["resident", "manager"], placeholders: ["applicantName", "propertyTitle", "url"] },
  { domain: "application", event: "cosigner_completed", area: "applications", label: "Cosigner submitted", audiences: ["manager"], placeholders: ["applicantName", "cosignerName", "propertyTitle"] },
  { domain: "application", event: "application_approved", area: "applications", label: "Approved", audiences: ["resident", "manager"], placeholders: ["applicantName", "propertyTitle"] },
  { domain: "application", event: "application_declined", area: "applications", label: "Declined", audiences: ["resident", "manager"], placeholders: ["applicantName", "propertyTitle"] },
  { domain: "application", event: "application_withdrawn", area: "applications", label: "Withdrawn", audiences: ["resident", "manager"], placeholders: ["applicantName", "propertyTitle"] },
  // ---- Tours ----
  { domain: "tour", event: "confirmed", area: "tours", label: "Tour confirmed", audiences: ["manager"], placeholders: ["guestName", "propertyTitle", "whenLabel"] },
  { domain: "tour", event: "cancelled_by_guest", area: "tours", label: "Cancelled by guest", audiences: ["manager"], placeholders: ["guestName", "propertyTitle", "whenLabel"] },
  { domain: "tour", event: "no_show", area: "tours", label: "No-show", audiences: ["resident"], placeholders: ["guestName", "propertyTitle", "slotsUrl"] },
  // ---- Inspections (a report has two sides; the resident submits theirs, the manager may reopen it) ----
  { domain: "inspection", event: "submitted", area: "inspections", label: "Resident submitted their photos", audiences: ["manager"], placeholders: ["residentName", "propertyTitle", "kind", "url"] },
  { domain: "inspection", event: "reopened", area: "inspections", label: "Report reopened for the resident", audiences: ["resident"], placeholders: ["residentName", "propertyTitle", "kind", "url"] },
  // ---- Tasks ----
  { domain: "task", event: "assigned", area: "tasks", label: "Task assigned", audiences: ["resident"], placeholders: ["title", "dueDateLabel", "url"] },
  { domain: "task", event: "completed", area: "tasks", label: "Task completed", audiences: ["manager"], placeholders: ["title", "assigneeName"] },
  // ---- Communication ----
  { domain: "message", event: "after_hours_ack", area: "communication", label: "After-hours reply", audiences: ["resident"], placeholders: ["residentName", "resumeLabel", "emergencyPhone"] },
  { domain: "message", event: "emergency_flagged", area: "communication", label: "Emergency flagged", audiences: ["resident", "manager"], placeholders: ["residentName", "excerpt"] },
];

export function automatedMessageCatalogForArea(area: AutomatedMessageCatalogEntry["area"]): AutomatedMessageCatalogEntry[] {
  return AUTOMATED_MESSAGE_CATALOG.filter((entry) => entry.area === area);
}

function normalizeTemplate(raw: unknown): { subject: string; body: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const subject = typeof row.subject === "string" ? row.subject.trim() : "";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  if (!subject && !body) return undefined;
  return { subject, body };
}

export function normalizeAutomatedMessageSettings(raw: unknown): AutomatedMessageSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: AutomatedMessageSettings = {};
  for (const [key, value] of Object.entries(row)) {
    if (!/^[a-z_]+:[a-z_]+:(manager|resident|vendor)$/.test(key)) continue;
    const entry = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const template = normalizeTemplate(entry.template);
    out[key] = { enabled: typeof entry.enabled === "boolean" ? entry.enabled : true, ...(template ? { template } : {}) };
  }
  return out;
}

/**
 * Apply the manager's setting to one rendered projection. Returns `null` when
 * the message is switched off for this audience, the default copy when there
 * is no entry, and the filled template otherwise.
 */
export function applyAutomatedMessageSetting(
  settings: AutomatedMessageSettings | null | undefined,
  input: {
    domain: string;
    event: string;
    audience: AutomatedMessageAudience;
    rendered: { subject: string; text: string; smsText?: string };
    context?: Record<string, string>;
  },
): { subject: string; text: string; smsText?: string } | null {
  const entry = settings?.[automatedMessageKey(input.domain, input.event, input.audience)];
  if (!entry) return input.rendered;
  if (!entry.enabled) return null;
  if (!entry.template) return input.rendered;
  const filled = fillReminderTemplate(
    { subject: entry.template.subject || input.rendered.subject, body: entry.template.body || input.rendered.text },
    input.context ?? {},
  );
  return { subject: filled.subject, text: filled.body, smsText: filled.body };
}
