import "server-only";

/**
 * The default copy of every automated message, rendered from the real
 * renderers with sample facts, so the Settings modal shows a manager exactly
 * what goes out today before they change it.
 */
import { AUTOMATED_MESSAGE_CATALOG, type AutomatedMessageAudience } from "@/lib/automated-messages-settings";
import {
  renderApplicationActionEvent,
  renderLeaseActionEvent,
  renderPaymentActionEvent,
  renderServiceRequestActionEvent,
  type ApplicationActionEvent,
  type LeaseActionEvent,
  type PaymentActionEvent,
  type ServiceRequestActionEvent,
} from "@/lib/domain-action-events.server";
import { renderWorkOrderEvent, type WorkOrderEventType } from "@/lib/work-order-events.server";
import { renderTourManagerEvent, type TourManagerEvent } from "@/lib/tour-events.server";
import { renderInspectionEvent } from "@/lib/inspection-events.server";

const SAMPLE = {
  workOrder: {
    reference: "WO-1042",
    title: "Leaking faucet",
    propertyLabel: "5257 Brooklyn Ave NE · Unit B",
    scheduledFor: "Thu, Sep 18 at 10:00 AM",
    vendorName: "Juniper Services",
    offerCount: 2,
    amountCents: 18000,
    accessInstructions: "Gate code 4471",
    residentContact: "Alex · (206) 555-0142",
    responsePromise: "within 1 business day",
    emergencyPhone: "(206) 555-0100",
    expiresLabel: "Thu, Sep 18 at 4:00 PM",
    note: "still dripping under the sink",
    residentName: "Alex Resident",
    confirmUrl: "https://prop-lane.space/services/confirm?t=…",
    ratingUrl: "https://prop-lane.space/services/confirm?t=…",
    rating: 5,
    etaMinutes: 25,
  },
};

export function automatedMessageDefaults(): Record<string, { subject: string; body: string }> {
  const out: Record<string, { subject: string; body: string }> = {};
  for (const entry of AUTOMATED_MESSAGE_CATALOG) {
    for (const audience of entry.audiences) {
      const rendered = renderDefault(entry.domain, entry.event, audience);
      if (rendered) out[`${entry.domain}:${entry.event}:${audience}`] = { subject: rendered.subject, body: rendered.text };
    }
  }
  return out;
}

function renderDefault(domain: string, event: string, audience: AutomatedMessageAudience): { subject: string; text: string } | null {
  if (domain === "work_order") return renderWorkOrderEvent(event as WorkOrderEventType, audience, SAMPLE.workOrder);
  if (audience === "vendor") return null;
  if (domain === "service_request") {
    return renderServiceRequestActionEvent(event as ServiceRequestActionEvent, audience, { offerName: "Parking", residentName: "Alex Resident", priceLabel: "$75" });
  }
  if (domain === "lease") {
    return renderLeaseActionEvent(event as LeaseActionEvent, audience, { residentName: "Alex Resident", propertyLabel: "5257 Brooklyn Ave NE" });
  }
  if (domain === "payment") {
    return renderPaymentActionEvent(event as PaymentActionEvent, audience, { title: "December rent", amountLabel: "$1,850.00", propertyLabel: "5257 Brooklyn Ave NE" });
  }
  if (domain === "application") {
    return renderApplicationActionEvent(event as ApplicationActionEvent, audience, { applicantName: "Alex Prospect", propertyLabel: "5257 Brooklyn Ave NE", responsePromise: "within 3 days" });
  }
  if (domain === "tour" && audience === "manager") {
    return renderTourManagerEvent(event as TourManagerEvent, { guestName: "Alex Prospect", propertyTitle: "5257 Brooklyn Ave NE", whenLabel: "Thu, Sep 18 · 4:00–4:30 PM", reason: "schedule changed" });
  }
  if (domain === "inspection") {
    return renderInspectionEvent(event as "submitted" | "reopened", audience, { residentName: "Alex Resident", propertyLabel: "5257 Brooklyn Ave NE · Room B", kind: "move_in" });
  }
  if (domain === "message") {
    if (event === "after_hours_ack" && audience === "resident") return { subject: "Thanks — we’ll reply in the morning", text: "Thanks — we are offline until 8:00 AM and will reply then. Emergency? Call (206) 555-0100." };
    if (event === "emergency_flagged" && audience === "manager") return { subject: "URGENT · Alex Resident", text: "URGENT from Alex Resident: “water everywhere under the sink”" };
    if (event === "emergency_flagged" && audience === "resident") return { subject: "We flagged this as urgent", text: "We flagged this as urgent and alerted your property manager." };
  }
  return null;
}
