/** Client helper — deliver to Axis inbox and optional email / SMS. */

import type { NotificationCategory } from "@/lib/notification-preferences";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { appendResidentPortalLoginInstructions } from "@/lib/resident-portal-login-copy";

export type PortalMessageDeliveryResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

export async function deliverPortalInboxMessage(input: {
  fromName?: string;
  toEmails?: string[];
  /** Resolve recipients from the sender's own relationships instead of explicit emails (e.g. a resident messaging "their manager"). */
  toBroadcast?: ("management" | "resident")[];
  subject: string;
  text: string;
  /** Gates email/SMS per recipient's saved preference for this category (inbox always on). Omitted → 'messages' default at the route. */
  eventCategory?: NotificationCategory;
  /** When set, overrides preference-driven email (still skips sandbox addresses server-side). */
  deliverViaEmail?: boolean;
  /** When true, also try SMS for recipients with phones. */
  deliverViaSms?: boolean;
}): Promise<PortalMessageDeliveryResult> {
  const toEmails = (input.toEmails ?? []).map((e) => e.trim()).filter((e) => e.includes("@"));
  if (toEmails.length === 0 && !input.toBroadcast?.length) {
    return { ok: false, error: "A valid recipient email is required." };
  }
  try {
    const res = await fetch("/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        fromName: input.fromName ?? "Property Manager",
        toEmails,
        toBroadcast: input.toBroadcast,
        subject: input.subject.trim(),
        text: input.text.trim(),
        deliverToPortalInbox: true,
        deliverViaEmail: input.deliverViaEmail !== false,
        deliverViaSms: input.deliverViaSms === true,
        eventCategory: input.eventCategory,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; skipped?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? "Could not deliver message." };
    }
    return { ok: true, skipped: data.skipped };
  } catch {
    return { ok: false, error: "Could not deliver message." };
  }
}

export function buildNewChargeNoticeBody(input: {
  residentName: string;
  residentEmail?: string;
  chargeTitle: string;
  amountLabel: string;
  dueDateLabel?: string;
  propertyLabel?: string;
}): string {
  const payUrl = residentPortalUrl("payments");
  const lines = [
    `Hi ${input.residentName || "there"},`,
    "",
    "A new charge has been added to your PropLane resident portal:",
    "",
    `${input.chargeTitle} — ${input.amountLabel}`,
  ];
  if (input.dueDateLabel?.trim()) lines.push(`Due: ${input.dueDateLabel.trim()}`);
  if (input.propertyLabel?.trim()) lines.push(`Property: ${input.propertyLabel.trim()}`);
  lines.push(
    "",
    `Review and pay: ${payUrl}`,
    "",
    "Questions? Reply to this text or message us in your PropLane inbox.",
    "",
    "PropLane",
  );
  return appendResidentPortalLoginInstructions(lines.join("\n"), {
    residentEmail: input.residentEmail,
    afterLoginHint: "payments",
  });
}

export function buildHoldingFeeNoticeBody(input: {
  residentName: string;
  residentEmail?: string;
  amountLabel: string;
  propertyLabel?: string;
}): string {
  const payUrl = residentPortalUrl("payments");
  const lines = [
    `Hi ${input.residentName || "there"},`,
    "",
    "Your property manager added a holding fee to your PropLane Payments tab:",
    "",
    `Holding deposit — ${input.amountLabel}`,
  ];
  if (input.propertyLabel?.trim()) lines.push(`Property: ${input.propertyLabel.trim()}`);
  lines.push(
    "",
    "Pay it from your Payments tab to hold the home while your application is reviewed.",
    "This amount counts toward your security deposit if your application is approved.",
    "",
    `Open Payments: ${payUrl}`,
    "",
    "Questions? Reply to this message or contact your property manager in PropLane.",
    "",
    "PropLane",
  );
  return appendResidentPortalLoginInstructions(lines.join("\n"), {
    residentEmail: input.residentEmail,
    afterLoginHint: "payments",
  });
}
