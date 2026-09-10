import { formatPacificDateTime } from "@/lib/pacific-time";
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import type { HouseholdCharge } from "@/lib/household-charges";
import { loadAllManagerRows } from "./load-manager-rows";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import {
  filterOverdueCharges,
  findOwnedOverdueCharge,
  buildRentReminderPreview,
  type RentReminderPreview,
} from "./payments-logic";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { appendResidentPortalLoginInstructions } from "@/lib/resident-portal-login-copy";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { normalizeE164 } from "@/lib/phone-e164";

/** Server-side read of the landlord's charges, scoped by manager_user_id. */
async function loadManagerCharges(ctx: AgentContext): Promise<HouseholdCharge[]> {
  return loadAllManagerRows(
    ctx,
    "portal_household_charge_records",
    (rowData) => rowData as HouseholdCharge,
  );
}

export const getOverdueChargesTool = defineTool({
  name: "get_overdue_charges",
  description:
    "List the current landlord's overdue charges (past due and unpaid): tenants who are late on rent or other charges. Returns each charge's id, resident name, amount due, property, and due date. Use this to answer 'who is late on rent' and similar questions, and to collect charge ids for send_rent_reminder.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const overdue = filterOverdueCharges(await loadManagerCharges(ctx));
    return { count: overdue.length, charges: overdue.map(buildRentReminderPreview) };
  },
});

/** Safe projection of a charge for listing (no internal/user-id fields). */
function summarizeCharge(c: HouseholdCharge) {
  return {
    id: c.id,
    residentName: c.residentName || null,
    residentEmail: (c.residentEmail || "").trim().toLowerCase() || null,
    property: c.propertyLabel || null,
    kind: c.kind || null,
    title: c.title || null,
    amount: c.amountLabel || null,
    balance: c.balanceLabel || null,
    status: c.status || null,
    dueDate: c.dueDateLabel || null,
  };
}

export const listChargesTool = defineTool({
  name: "list_charges",
  description:
    "List the current landlord's household charges (rent, deposits, fees, and other charges), optionally filtered by status or resident. Returns each charge's id, resident, property, kind, amount, balance, status, and due date. Use for questions like 'what charges does this tenant have' or 'show all unpaid deposits'. For who is *late*, prefer get_overdue_charges.",
  kind: "read",
  inputSchema: z
    .object({
      status: z
        .string()
        .optional()
        .describe("Optional case-insensitive filter on charge status, e.g. 'paid' or 'pending'."),
      residentEmail: z
        .string()
        .optional()
        .describe("Optional case-insensitive filter to a single resident's email."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const wantStatus = input.status?.trim().toLowerCase();
    const wantEmail = input.residentEmail?.trim().toLowerCase();
    const filtered = (await loadManagerCharges(ctx)).filter((c) => {
      if (wantStatus && String(c.status ?? "").toLowerCase() !== wantStatus) return false;
      if (wantEmail && String(c.residentEmail ?? "").trim().toLowerCase() !== wantEmail) return false;
      return true;
    });
    return { count: filtered.length, charges: filtered.map(summarizeCharge) };
  },
});

/** Builds the reminder email/inbox body from authoritative server data. */
function buildReminderBody(p: RentReminderPreview): string {
  const lines = [`Hi ${p.residentName},`, "", `This is a reminder that your ${p.chargeTitle} payment is outstanding.`];
  if (p.balanceDue) lines.push(`Amount due: ${p.balanceDue}`);
  if (p.propertyLabel) lines.push(`Property: ${p.propertyLabel}`);
  lines.push("", "PropLane");
  return appendResidentPortalLoginInstructions(lines.join("\n"), {
    residentEmail: p.residentEmail,
    afterLoginHint: "payments",
  });
}

export type ReminderChannel = "portal" | "email" | "sms";
type ChannelOutcome = "sent" | "queued" | "deferred" | "failed" | "unknown" | "skipped";

export type ReminderDelivery = {
  portal: ChannelOutcome;
  email: ChannelOutcome;
  sms: ChannelOutcome;
};

const DEFAULT_REMINDER_CHANNELS: readonly ReminderChannel[] = ["portal", "email"];

function requestedChannels(channels: readonly ReminderChannel[] | undefined): Set<ReminderChannel> {
  return new Set(channels?.length ? channels : DEFAULT_REMINDER_CHANNELS);
}

function smsOutcomeFromOutbox(status: string): ChannelOutcome {
  if (status === "queued") return "queued";
  if (status === "deferred") return "deferred";
  if (status === "unknown") return "unknown";
  return "failed";
}

function deliveryReplyPart(label: string, outcome: ChannelOutcome): string {
  if (outcome === "sent") return `${label} sent`;
  if (outcome === "queued" || outcome === "deferred") return `${label} ${outcome}`;
  if (outcome === "unknown") return `${label} outcome unknown`;
  if (outcome === "skipped") return `${label} unavailable`;
  return `${label} failed`;
}

/**
 * Per-charge reminder core. The charge MUST already be re-resolved from the
 * landlord's own overdue set — every value that reaches an outbound channel
 * comes from that record, never from client- or model-supplied input. Records
 * intent in audit_log BEFORE sending, idempotent per charge per day.
 */
async function sendReminderForCharge(
  ctx: AgentContext,
  charge: HouseholdCharge,
  channelsInput?: readonly ReminderChannel[],
): Promise<{ preview: RentReminderPreview; delivery: ReminderDelivery; alreadySent?: boolean }> {
  const preview = buildRentReminderPreview(charge);
  const subject = `Payment reminder: ${preview.chargeTitle}`;
  const body = buildReminderBody(preview);
  const channels = requestedChannels(channelsInput);

  // 1. Record intent first, idempotently. A duplicate on the dedupe key means
  //    this charge was already reminded today — do not send again. Any other
  //    audit error fails loudly: we never send without an audit record.
  const dedupeKey = `send_rent_reminder:${ctx.landlordId}:${preview.chargeId}:${auditDayBucket()}`;
  const audit = await writeAuditLog(ctx, {
    action: "send_rent_reminder",
    toolName: "send_rent_reminder",
    inputSummary: { chargeId: preview.chargeId },
    resultSummary: { residentEmail: preview.residentEmail },
    dedupeKey,
  });
  if (!audit.recorded) {
    if (audit.duplicate) {
      return {
        preview,
        delivery: { portal: "skipped", email: "skipped", sms: "skipped" },
        alreadySent: true,
      };
    }
    throw new Error("Could not record the action; no reminder was sent.");
  }

  // 2. Email via Resend. Skipped for demo addresses or when Resend is not
  //    configured (portal-only delivery); a real failure is reported honestly.
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const isDemoAddress = preview.residentEmail.endsWith("@axis.local") || preview.residentEmail === ctx.email;
  // An empty/invalid resident email (e.g. missing in untrusted row_data) has no
  // deliverable address: record in the portal rather than attempting a doomed send.
  const hasDeliverableEmail = preview.residentEmail.includes("@");
  let email: ChannelOutcome = "skipped";
  if (channels.has("email") && apiKey && !isDemoAddress && hasDeliverableEmail) {
    try {
      const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [preview.residentEmail], subject, text: body }),
      });
      email = res.ok ? "sent" : "failed";
    } catch {
      email = "failed";
    }
  }

  // 3. Portal is a resident-side inbox delivery, not a manager Sent-row stand-in.
  // The profile lookup also supplies the only server-trusted phone/account identity
  // for the optional SMS leg below.
  const { data: residentProfile, error: residentProfileError } = await ctx.db
    .from("profiles")
    .select("id, phone, phone_verified_at")
    .eq("email", preview.residentEmail)
    .maybeSingle();
  const residentUserId = String(residentProfile?.id ?? "").trim() || null;
  let portal: ChannelOutcome = residentProfileError ? "failed" : "skipped";
  if (channels.has("portal") && residentUserId && !residentProfileError) {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const when = formatPacificDateTime(new Date());
    try {
      await deliverPortalMessageThreadSide(ctx.db, {
        scope: "axis_portal_inbox_resident_v1",
        folder: "inbox",
        ownerUserId: residentUserId,
        participantEmail: preview.residentEmail,
        otherPartyEmail: ctx.email,
        fallbackId: `payment_reminder_${ctx.landlordId}_${ts}_${rand}`,
        fromName: "PropLane Assistant",
        subject,
        body,
        preview: body.slice(0, 100).replace(/\n/g, " "),
        when,
        unread: true,
        outbound: false,
      });
      portal = "sent";
    } catch {
      portal = "failed";
    }
  }

  let sms: ChannelOutcome = residentProfileError ? "failed" : "skipped";
  if (channels.has("sms")) {
    const phone = residentProfile?.phone_verified_at ? normalizeE164(residentProfile.phone) : null;
    if (phone) {
      const conversationKey = buildConversationKey({
        ownerManagerUserId: ctx.landlordId,
        role: "resident",
        counterpartyUserId: residentUserId,
        counterpartyPhone: phone,
      });
      try {
        const smsResult = await enqueueOwnerSms({
          managerUserId: ctx.landlordId,
          actorUserId: ctx.userId,
          recipientPhone: phone,
          recipientUserId: residentUserId,
          recipientEmail: preview.residentEmail,
          propertyId: charge.propertyId,
          body: `Hi ${preview.residentName}, just a reminder that your ${preview.chargeTitle} payment is outstanding. Please check PropLane for your payment details.`,
          sendClass: "transactional",
          purpose: "manual_rent_reminder",
          conversationKey,
          counterpartyRole: "resident",
          dedupeKey: `manual_rent_reminder:${ctx.landlordId}:${preview.chargeId}:${auditDayBucket()}`,
        }, ctx.db);
        sms = smsResult.ok ? smsOutcomeFromOutbox(smsResult.status) : "failed";
      } catch {
        sms = "failed";
      }
    }
  }

  const delivery = { portal, email, sms };

  // Stamp the actual per-channel state. An accepted SMS is queued/deferred,
  // never represented as delivered before the outbox/provider path says so.
  const noChannelAccepted = ![portal, email, sms].some(
    (outcome) => outcome === "sent" || outcome === "queued" || outcome === "deferred",
  );
  await updateAuditResult(
    ctx,
    dedupeKey,
    { residentEmail: preview.residentEmail, delivery },
    { clearDedupeKey: noChannelAccepted },
  );

  return { preview, delivery };
}

/**
 * Single-charge executor kept for existing callers/tests; the registry tool
 * below is the batch-capable public surface.
 */
export type SendRentReminderResult =
  | { ok: true; preview: RentReminderPreview; delivery: ReminderDelivery; alreadySent?: boolean }
  | { ok: false; error: string };

export async function executeSendRentReminder(
  ctx: AgentContext,
  chargeId: string,
): Promise<SendRentReminderResult> {
  const charge = findOwnedOverdueCharge(await loadManagerCharges(ctx), chargeId);
  if (!charge) {
    return { ok: false, error: "No matching overdue charge for this landlord." };
  }
  try {
    const { preview, delivery, alreadySent } = await sendReminderForCharge(ctx, charge);
    return { ok: true, preview, delivery, ...(alreadySent ? { alreadySent: true } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The reminder could not be sent." };
  }
}

const PREVIEW_LINE_CAP = 8;

/**
 * The reference write tool: batch-capable payment reminders. preview()
 * validates every charge id against the landlord's own overdue set; execute()
 * loops the per-charge core (each item independently idempotent per day).
 */
export const sendRentReminderTool = defineWriteTool({
  name: "send_rent_reminder",
  description:
    "Send a confirmed payment reminder to residents with overdue charges. Choose portal, email, and/or SMS; SMS is durably queued from the manager's property work number and is never reported as delivered before the outbox records that outcome. Pass charge ids from get_overdue_charges.",
  inputSchema: z
    .object({
      chargeIds: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Ids of overdue charges (from get_overdue_charges) to send reminders for."),
      channels: z
        .array(z.enum(["portal", "email", "sms"]))
        .min(1)
        .max(3)
        .optional()
        .describe("Requested delivery channels. Use portal, email, and sms when the landlord explicitly asks for all three."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const charges = await loadManagerCharges(ctx);
    const uniqueIds = [...new Set(input.chargeIds.map((id) => id.trim()).filter(Boolean))];
    const resolved: RentReminderPreview[] = [];
    const invalid: string[] = [];
    for (const id of uniqueIds) {
      const charge = findOwnedOverdueCharge(charges, id);
      if (charge) resolved.push(buildRentReminderPreview(charge));
      else invalid.push(id);
    }
    if (invalid.length > 0) {
      throw new Error(`These ids are not overdue charges owned by this landlord: ${invalid.join(", ")}. Use get_overdue_charges to get valid charge ids.`);
    }
    const lines = resolved.slice(0, PREVIEW_LINE_CAP).map((p) => ({
      label: p.residentName,
      value: `${p.chargeTitle}${p.balanceDue ? ` (${p.balanceDue})` : ""}`,
    }));
    if (resolved.length > PREVIEW_LINE_CAP) {
      lines.push({ label: "…", value: `and ${resolved.length - PREVIEW_LINE_CAP} more` });
    }
    const selectedChannels = requestedChannels(input.channels);
    lines.push({
      label: "Delivery",
      value: [...selectedChannels].map((channel) => (channel === "sms" ? "SMS (queued)" : channel)).join(" + "),
    });
    return {
      confirmedInput: {
        chargeIds: resolved.map((p) => p.chargeId),
        ...(input.channels?.length ? { channels: [...new Set(input.channels)] } : {}),
      },
      kind: "send_rent_reminder",
      title: resolved.length === 1 ? "Send rent reminder" : "Send rent reminders",
      summary:
        resolved.length === 1
          ? `Send a payment reminder to ${resolved[0]!.residentName} for ${resolved[0]!.chargeTitle}${resolved[0]!.balanceDue ? ` (${resolved[0]!.balanceDue})` : ""}.`
          : `Send payment reminders to ${resolved.length} residents with overdue charges.`,
      fields: lines,
      warnings: selectedChannels.has("sms")
        ? ["SMS is queued through the property work-number outbox. Confirmation does not prove provider delivery."]
        : undefined,
      confirmLabel: resolved.length === 1 ? "Send reminder" : `Send ${resolved.length} reminders`,
      ...(resolved.length > 1 ? { batchCount: resolved.length } : {}),
    };
  },
  handler: async (ctx, input) => {
    const charges = await loadManagerCharges(ctx);
    const outcomes: Record<ReminderChannel, Record<ChannelOutcome, number>> = {
      portal: { sent: 0, queued: 0, deferred: 0, failed: 0, unknown: 0, skipped: 0 },
      email: { sent: 0, queued: 0, deferred: 0, failed: 0, unknown: 0, skipped: 0 },
      sms: { sent: 0, queued: 0, deferred: 0, failed: 0, unknown: 0, skipped: 0 },
    };
    let alreadySent = 0;
    let skipped = 0;
    for (const id of input.chargeIds) {
      // Re-resolve at execute time: overdue state may have changed since preview.
      const charge = findOwnedOverdueCharge(charges, id);
      if (!charge) {
        skipped += 1;
        continue;
      }
      try {
        const { delivery, alreadySent: duplicate } = await sendReminderForCharge(ctx, charge, input.channels);
        if (duplicate) {
          alreadySent += 1;
          continue;
        }
        for (const channel of ["portal", "email", "sms"] as const) outcomes[channel][delivery[channel]] += 1;
      } catch {
        outcomes.email.failed += 1;
      }
    }
    const parts: string[] = [];
    const requested = requestedChannels(input.channels);
    for (const channel of ["portal", "email", "sms"] as const) {
      if (!requested.has(channel)) continue;
      for (const outcome of ["sent", "queued", "deferred", "unknown", "failed", "skipped"] as const) {
        const count = outcomes[channel][outcome];
        if (count) parts.push(`${deliveryReplyPart(channel, outcome)} for ${count}`);
      }
    }
    if (alreadySent) parts.push(`${alreadySent} already sent today`);
    if (skipped) parts.push(`${skipped} no longer overdue and skipped`);
    const reply = parts.length
      ? `Done — ${parts.join("; ")}.`
      : "Nothing to send — no matching overdue charges remained.";
    return { reply, resultSummary: { outcomes, alreadySent, skipped } };
  },
});
