/**
 * Resident SMS command hub — run classified intents (chatbot actions + manager brief).
 */

import type { HouseholdCharge } from "@/lib/household-charges";
import {
  createWorkOrderFromResidentSms,
  maintenanceWorkOrderResidentAck,
} from "@/lib/claw-maintenance-work-order.server";
import {
  createServiceRequestFromResidentSms,
  serviceRequestResidentAck,
} from "@/lib/claw-service-request-sms.server";
import {
  classifyResidentSmsIntent,
  residentGreetingText,
  residentHelpMenuText,
  type ClassifiedResidentSms,
} from "@/lib/claw-resident-intents";
import { managerPortalUrlFromPath, residentPortalUrl } from "@/lib/claw-resident-links";
import { residentInboundAck, type ClawThreadTopic } from "@/lib/claw-resident-messaging.server";
import { reportManualPaymentForResident } from "@/lib/resident-report-manual-payment.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export type ResidentSmsActionResult = {
  classification: ClassifiedResidentSms;
  residentReply: string;
  /** Extra lines appended under the brief (auto-filed ids, etc.). */
  autoFiledNote: string | null;
  threadTopic: ClawThreadTopic;
  forwardSaid: string;
  /** Property label for manager brief header (resolved from residency). */
  propertyLabel: string | null;
};

/**
 * Manager-phone alert header + body.
 * Top lines always identify property + resident (looked up from the sender phone),
 * then the resident's message, then what PropLane replied.
 */
export function buildManagerResidentBrief(args: {
  residentName: string;
  residentEmail?: string | null;
  residentPhone: string;
  said: string;
  wants: string;
  domain: string;
  managerPath: string;
  autoFiledNote?: string | null;
  propertyLabel?: string | null;
  /** What PropLane sent back to the resident. */
  reply?: string | null;
}): string {
  const name = args.residentName.trim() || "Resident";
  const phone = args.residentPhone.trim();
  const property = args.propertyLabel?.trim() || "Unknown property";
  const residentLine = phone ? `${name} (${phone})` : name;
  const said = (args.said || "").trim() || "(empty)";
  const reply = args.reply?.trim() || "";

  const lines = [
    `Property: ${property}`,
    `Resident: ${residentLine}`,
    `Said: ${said}`,
  ];
  if (reply) {
    lines.push(`Reply: ${reply}`);
  }
  if (args.autoFiledNote?.trim()) {
    lines.push("", args.autoFiledNote.trim(), `Review: ${managerPortalUrlFromPath(args.managerPath)}`);
  }
  return lines.join("\n");
}

export function formatPendingChargesForSms(charges: HouseholdCharge[]): string {
  const pay = residentPortalUrl("payments");
  if (charges.length === 0) {
    return `You're all caught up — nothing due right now.\n${pay}`;
  }
  const lines = ["Here's what's open:"];
  for (const c of charges.slice(0, 8)) {
    const due = c.dueDateLabel?.trim() ? ` (due ${c.dueDateLabel.trim()})` : "";
    const balance = (c.balanceLabel || c.amountLabel || "").trim() || "—";
    lines.push(`${c.title.trim() || "Charge"} — ${balance}${due}`);
  }
  if (charges.length > 8) lines.push(`…plus ${charges.length - 8} more`);
  lines.push(`You can pay here: ${pay}`);
  return lines.join("\n");
}

async function listPendingChargesForResident(args: {
  residentEmail: string;
  managerUserId?: string | null;
}): Promise<HouseholdCharge[]> {
  const email = args.residentEmail.trim().toLowerCase();
  const db = createSupabaseServiceRoleClient();
  let q = db
    .from("portal_household_charge_records")
    .select("row_data, status")
    .eq("resident_email", email)
    .in("status", ["pending", "processing", "partially_paid", "failed"]);
  if (args.managerUserId?.trim()) {
    q = q.eq("manager_user_id", args.managerUserId.trim());
  }
  const { data } = await q.order("updated_at", { ascending: false }).limit(30);
  const out: HouseholdCharge[] = [];
  for (const row of data ?? []) {
    const charge = (row as { row_data?: HouseholdCharge }).row_data;
    if (!charge?.id) continue;
    if (charge.status === "paid" || charge.status === "cancelled" || charge.status === "refunded") continue;
    out.push(charge);
  }
  return out;
}

async function resolveResidentDisplayName(args: {
  residentUserId?: string | null;
  residentEmail: string;
}): Promise<string> {
  const db = createSupabaseServiceRoleClient();
  if (args.residentUserId) {
    const { data } = await db.from("profiles").select("full_name").eq("id", args.residentUserId).maybeSingle();
    const name = String((data as { full_name?: unknown } | null)?.full_name ?? "").trim();
    if (name) return name;
  }
  const { data: app } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("resident_email", args.residentEmail.trim().toLowerCase())
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const name = String(((app as { row_data?: { name?: string } } | null)?.row_data ?? {}).name ?? "").trim();
  return name || "Resident";
}

/** Resolve property display name for a resident under a manager (phone → email → residency). */
export async function resolveResidentPropertyLabel(args: {
  residentEmail?: string | null;
  managerUserId: string;
}): Promise<string | null> {
  const email = (args.residentEmail ?? "").trim().toLowerCase();
  const managerUserId = args.managerUserId.trim();
  if (!email || !managerUserId) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: app } = await db
    .from("manager_application_records")
    .select("row_data, property_id, assigned_property_id")
    .eq("resident_email", email)
    .eq("manager_user_id", managerUserId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const rowData = (app as { row_data?: Record<string, unknown> } | null)?.row_data ?? {};
  const fromRow =
    String(rowData.propertyTitle ?? "").trim() ||
    String(rowData.property ?? "").trim() ||
    String((rowData.application as { propertyTitle?: string } | undefined)?.propertyTitle ?? "").trim();
  if (fromRow) return fromRow;

  const propertyId =
    String((app as { assigned_property_id?: unknown } | null)?.assigned_property_id ?? "").trim() ||
    String((app as { property_id?: unknown } | null)?.property_id ?? "").trim() ||
    String(rowData.assignedPropertyId ?? "").trim() ||
    String(rowData.propertyId ?? "").trim() ||
    String((rowData.application as { propertyId?: string } | undefined)?.propertyId ?? "").trim();
  if (!propertyId) return null;

  const { data: prop } = await db
    .from("manager_property_records")
    .select("property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();
  const propertyData = (prop as { property_data?: Record<string, unknown> } | null)?.property_data ?? {};
  const propRow = (prop as { row_data?: Record<string, unknown> } | null)?.row_data ?? {};
  const title =
    String(propertyData.title ?? "").trim() ||
    String(propertyData.buildingName ?? "").trim() ||
    String(propRow.buildingName ?? "").trim() ||
    String(propRow.title ?? "").trim();
  return title || null;
}

export async function runResidentSmsAction(args: {
  text: string;
  residentPhone: string;
  managerUserId: string;
  residentUserId?: string | null;
  residentEmail?: string | null;
  threadTopic?: ClawThreadTopic;
}): Promise<ResidentSmsActionResult & { residentName: string }> {
  const text = args.text.trim();
  const classification = classifyResidentSmsIntent(text);
  const residentEmail = (args.residentEmail ?? "").trim().toLowerCase();
  const [residentName, propertyLabel] = await Promise.all([
    residentEmail
      ? resolveResidentDisplayName({
          residentUserId: args.residentUserId,
          residentEmail,
        })
      : Promise.resolve("Resident"),
    resolveResidentPropertyLabel({
      residentEmail: residentEmail || null,
      managerUserId: args.managerUserId,
    }),
  ]);

  let residentReply = "";
  let autoFiledNote: string | null = null;
  let threadTopic: ClawThreadTopic = args.threadTopic ?? "general";
  let wants = classification.wantsLabel;

  switch (classification.intent) {
    case "help":
    case "greeting": {
      residentReply =
        classification.intent === "greeting"
          ? [residentGreetingText(residentName), residentHelpMenuText()].join("\n\n")
          : residentHelpMenuText();
      break;
    }
    case "maintenance": {
      if (!residentEmail) {
        residentReply = `Mind using this link so we can file it under your unit?\n${residentPortalUrl("services_work_orders")}`;
        break;
      }
      const wo = await createWorkOrderFromResidentSms({
        managerUserId: args.managerUserId,
        residentPhone: args.residentPhone,
        residentUserId: args.residentUserId,
        residentEmail,
        text,
        senderUserId: args.residentUserId,
      });
      residentReply =
        maintenanceWorkOrderResidentAck(wo) ||
        `Got it — can you send a bit more detail (or use this link)?\n${residentPortalUrl("services_work_orders")}`;
      if ("workOrderId" in wo && wo.workOrderId) {
        autoFiledNote = wo.created
          ? `PropLane auto-filed work order ${wo.workOrderId} (${wo.title}).`
          : wo.alreadyOpen
            ? `PropLane matched existing work order ${wo.workOrderId} (${wo.title}).`
            : null;
        wants = wo.created
          ? `file maintenance service (${wo.title})`
          : `follow up on open service (${wo.title})`;
      }
      threadTopic = "maintenance";
      break;
    }
    case "service_request": {
      if (!residentEmail) {
        residentReply = `Sure — easiest is this link:\n${residentPortalUrl("services")}`;
        break;
      }
      const sr = await createServiceRequestFromResidentSms({
        managerUserId: args.managerUserId,
        residentEmail,
        residentUserId: args.residentUserId,
        residentName,
        text,
      });
      residentReply =
        serviceRequestResidentAck(sr) ||
        `Gotcha — mind trying again here?\n${residentPortalUrl("services")}`;
      if ("requestId" in sr && sr.requestId) {
        autoFiledNote = sr.created
          ? `PropLane auto-filed add-on service request ${sr.requestId} (${sr.title}).`
          : sr.alreadyOpen
            ? `PropLane matched existing add-on service request ${sr.requestId} (${sr.title}).`
            : null;
        wants = `submit add-on service request (${sr.title})`;
      }
      threadTopic = "services";
      break;
    }
    case "balance":
    case "pay": {
      threadTopic = "payment";
      if (!residentEmail) {
        residentReply = `Here's payments:\n${residentPortalUrl("payments")}`;
        break;
      }
      const charges = await listPendingChargesForResident({
        residentEmail,
        managerUserId: args.managerUserId,
      });
      residentReply = formatPendingChargesForSms(charges);
      wants =
        classification.intent === "balance"
          ? `see balance (${charges.length} open charge${charges.length === 1 ? "" : "s"})`
          : `pay rent / open payment link (${charges.length} open)`;
      break;
    }
    case "i_paid": {
      threadTopic = "payment";
      if (!residentEmail) {
        residentReply = `Cool — can you note it here so we can match it?\n${residentPortalUrl("payments")}`;
        break;
      }
      const report = await reportManualPaymentForResident({
        residentUserId: args.residentUserId,
        residentEmail,
        textHint: text,
        managerUserId: args.managerUserId,
      });
      if (!report.ok) {
        residentReply = [
          "Hmm, I couldn't match that to an open charge.",
          `Can you mark it here? ${residentPortalUrl("payments")}`,
        ].join("\n");
        wants = "confirm offline payment (no open charge matched)";
        break;
      }
      const channelLabel = report.channel === "venmo" ? "Venmo" : "Zelle";
      residentReply = [
        `Nice — noted you paid via ${channelLabel}.`,
        "We'll confirm once it shows up on our side.",
      ].join("\n");
      autoFiledNote = `Resident reported ${channelLabel} payment on ${report.charges.length} charge(s).`;
      wants = `confirm ${channelLabel} payment received`;
      break;
    }
    case "lease": {
      threadTopic = "lease";
      residentReply = `Lease is here if you need it:\n${residentPortalUrl("lease")}`;
      break;
    }
    case "applications": {
      threadTopic = "applications";
      if (!residentEmail) {
        residentReply = [
          "Don't think I have an app tied to this number yet.",
          `You can apply here: ${residentPortalUrl("apply")}`,
        ].join("\n");
        break;
      }
      const db = createSupabaseServiceRoleClient();
      let appQ = db
        .from("manager_application_records")
        .select("id, row_data, manager_user_id")
        .eq("resident_email", residentEmail)
        .order("updated_at", { ascending: false })
        .limit(5);
      if (args.managerUserId?.trim()) {
        appQ = appQ.eq("manager_user_id", args.managerUserId.trim());
      }
      const { data: appRows } = await appQ;
      const latest = (appRows ?? [])[0] as
        | { id?: string; row_data?: { bucket?: string; propertyTitle?: string; name?: string } }
        | undefined;
      if (!latest?.row_data) {
        residentReply = [
          "I don't see an application on file for you yet.",
          `Want to start one? ${residentPortalUrl("apply")}`,
        ].join("\n");
        break;
      }
      const bucket = String(latest.row_data.bucket ?? "pending").toLowerCase();
      const statusLabel =
        bucket === "approved"
          ? "you're approved"
          : bucket === "rejected"
            ? "it wasn't approved"
            : "it's still under review";
      const where = String(latest.row_data.propertyTitle ?? "").trim();
      residentReply = [
        `For your application${where ? ` at ${where}` : ""} — ${statusLabel}.`,
        `More here if you need it: ${residentPortalUrl("applications")}`,
      ].join("\n");
      wants = `application status (${statusLabel})`;
      break;
    }
    case "move_in": {
      threadTopic = "move_in";
      residentReply = `Move-in stuff is here:\n${residentPortalUrl("move_in")}`;
      break;
    }
    case "inbox": {
      residentReply = "Got it — I'll make sure your manager sees this.";
      break;
    }
    default: {
      residentReply = residentInboundAck(args.threadTopic ?? "general");
      break;
    }
  }

  return {
    classification: { ...classification, wantsLabel: wants },
    residentReply,
    autoFiledNote,
    threadTopic,
    forwardSaid: text,
    residentName,
    propertyLabel,
  };
}
