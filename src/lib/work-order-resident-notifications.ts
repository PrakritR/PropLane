import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";

type WorkOrderUpdateKind = "vendor_assigned" | "visit_scheduled";

type SendResult = { ok: boolean; skipped?: boolean; error?: string };

export function buildResidentWorkOrderUpdate(
  kind: WorkOrderUpdateKind,
  row: DemoManagerWorkOrderRow,
  extras?: { scheduledLabel?: string },
): { subject: string; text: string } {
  const title = row.title?.trim() || "Service";
  const name = row.residentName?.trim() || "there";

  if (kind === "vendor_assigned") {
    const vendorName = row.vendorName?.trim() || "A vendor";
    return {
      subject: `Update on "${title}": vendor assigned`,
      text: [
        `Hi ${name},`,
        "",
        `${vendorName} has been assigned to your service "${title}".`,
        "They'll be in touch to schedule a visit.",
        "",
        "PropLane",
      ].join("\n"),
    };
  }

  const scheduledLabel = extras?.scheduledLabel?.trim() || row.scheduled || "soon";
  return {
    subject: `Update on "${title}": visit scheduled for ${scheduledLabel}`,
    text: [
      `Hi ${name},`,
      "",
      `Your service "${title}" has a visit scheduled for ${scheduledLabel}.`,
      "",
      "PropLane",
    ].join("\n"),
  };
}

export async function notifyResidentOfWorkOrderUpdate(
  kind: WorkOrderUpdateKind,
  row: DemoManagerWorkOrderRow,
  extras?: {
    scheduledLabel?: string;
    subject?: string;
    text?: string;
    viaEmail?: boolean;
    viaSms?: boolean;
  },
): Promise<SendResult> {
  const residentEmail = row.residentEmail?.trim();
  if (!residentEmail?.includes("@")) return { ok: false, skipped: true };

  const built = buildResidentWorkOrderUpdate(kind, row, extras);
  const subject = extras?.subject?.trim() || built.subject;
  const text = extras?.text?.trim() || built.text;
  return deliverPortalInboxMessage({
    fromName: "PropLane Portal",
    toEmails: [residentEmail],
    subject,
    text,
    eventCategory: "maintenance",
    deliverViaEmail: extras?.viaEmail !== false,
    deliverViaSms: extras?.viaSms !== false,
  });
}
