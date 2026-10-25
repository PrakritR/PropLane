import { createHash } from "node:crypto";
import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { auditDayBucket, updateAuditResult, writeAuditLog } from "../audit";
import { withBodyWarnings } from "../preview-body";
import { rowAllowedInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import { isVendorCategorySettingsRow, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { readRosterVendorTextStatus, sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * `message_vendor`: "text Mike's Plumbing: does Tuesday 10am work?". The vendor is matched against the
 * manager's OWN roster (`manager_vendor_records`, scoped to `ctx.landlordId`) at preview AND execute time,
 * so an id or name the model invents can never reach another manager's vendor or a stranger's number. The
 * send is the one roster path (`sendManagerConversationSms` with `vendorRecordId`): the line, the consent
 * and STOP rules, the sender line on a first text and the destination (the vendor's dedicated PropLane
 * number when routable, else their saved phone, decided by `providerDestinationFor`) are all decided there.
 */

type RosterMatch = { recordId: string; name: string; phone: string | null };

async function loadRoster(ctx: AgentContext): Promise<Array<RosterMatch & { active: boolean }>> {
  const { data, error } = await ctx.db
    .from("manager_vendor_records")
    .select("id, manager_user_id, row_data")
    .eq("manager_user_id", ctx.landlordId);
  if (error) throw new Error("Could not read your vendors.");
  const out: Array<RosterMatch & { active: boolean }> = [];
  for (const record of (data ?? []) as Array<{ id: unknown; manager_user_id?: unknown; row_data?: unknown }>) {
    if (String(record.manager_user_id ?? ctx.landlordId) !== ctx.landlordId) continue;
    const row = (record.row_data ?? null) as ManagerVendorRow | null;
    if (!row || isVendorCategorySettingsRow(row)) continue;
    if (!rowAllowedInAgentWorkspace(ctx, row)) continue;
    out.push({
      recordId: String(record.id),
      name: String(row.name ?? "").trim(),
      phone: normalizeE164(String(row.phone ?? "").trim()),
      active: row.active !== false,
    });
  }
  return out;
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** One roster vendor, or a refusal that says why. Never guesses between several. */
export async function resolveRosterVendor(ctx: AgentContext, query: string): Promise<RosterMatch> {
  const wanted = query.trim();
  if (!wanted) throw new Error("Say which vendor to text.");
  const roster = (await loadRoster(ctx)).filter((vendor) => vendor.active);
  const byId = roster.find((vendor) => vendor.recordId === wanted);
  if (byId) return byId;
  const key = norm(wanted);
  if (!key) throw new Error("Say which vendor to text.");
  const exact = roster.filter((vendor) => norm(vendor.name) === key);
  const pool = exact.length > 0 ? exact : roster.filter((vendor) => norm(vendor.name).includes(key) || (norm(vendor.name) && key.includes(norm(vendor.name))));
  if (pool.length === 0) {
    throw new Error(`"${wanted}" is not on your vendor list. Add them in Vendors first, then ask again. Nothing was sent.`);
  }
  if (pool.length > 1) {
    throw new Error(`More than one vendor matches "${wanted}": ${pool.map((vendor) => vendor.name).join(", ")}. Say which one. Nothing was sent.`);
  }
  return pool[0]!;
}

const messageVendorSchema = z
  .object({
    vendor: z.string().trim().min(1).max(200).describe("The vendor's name or id from list_vendors. Must be on the landlord's own vendor list."),
    message: z.string().trim().min(1).max(1000).describe("The text to send, plain words, no emoji."),
  })
  .strict();

export const messageVendorTool = defineWriteTool({
  name: "message_vendor",
  description:
    "Text one vendor on the landlord's own vendor list ('text Mike's Plumbing: does Tuesday 10am work?'). The vendor must be on the roster; a name that matches nobody or several vendors is refused. The text goes out from the workspace's work line to the vendor's PropLane number when they have one, else their saved phone. The landlord confirms the exact text first.",
  inputSchema: messageVendorSchema,
  allowedIdentityInputs: ["vendor"],
  preview: async (ctx, input) => {
    const vendor = await resolveRosterVendor(ctx, input.vendor);
    if (!vendor.phone) throw new Error(`${vendor.name || "That vendor"} has no phone number on file. Add one in Vendors first. Nothing was sent.`);
    const status = await readRosterVendorTextStatus(ctx.db, { actorUserId: ctx.userId, vendorRecordId: vendor.recordId, scopeManagerIds: [ctx.landlordId] });
    if (status.status < 200 || status.status >= 300) throw new Error(String(status.body.error || "That vendor cannot be texted right now."));
    if (status.body.optedOut === true) throw new Error(`${vendor.name} has opted out of texts. Nothing was sent.`);
    const firstText = status.body.needsAttestation === true;
    return {
      kind: "message_vendor",
      title: "Text a vendor",
      summary: `Text ${vendor.name}: "${input.message}"`,
      confirmLabel: "Send text",
      fields: [
        { label: "To", value: vendor.name },
        { label: "Message", value: input.message },
        {
          label: "Delivery",
          value: status.body.workNumber ? "SMS from your work line to their PropLane number" : "SMS from your work line to their phone",
        },
        ...(firstText
          ? [{ label: "First text", value: "Confirming sends your name and a STOP line, and says you work with this vendor" }]
          : []),
      ],
      ...withBodyWarnings(input.message),
      // The vendor is pinned to the roster record the manager saw; the handler re-verifies it.
      confirmedInput: { ...input, vendor: vendor.recordId },
    };
  },
  handler: async (ctx, input) => {
    const vendor = await resolveRosterVendor(ctx, input.vendor);
    if (!vendor.phone) throw new Error("That vendor has no phone number on file. Nothing was sent.");
    const dedupeKey = `message_vendor_${createHash("sha256")
      .update(JSON.stringify([ctx.userId, vendor.recordId, input.message, auditDayBucket()]))
      .digest("hex")}`;
    const audit = await writeAuditLog(ctx, {
      action: "message_vendor",
      toolName: "message_vendor",
      inputSummary: { vendorRecordId: vendor.recordId, channel: "sms" },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "This exact text to that vendor was already requested today. Check the thread for its delivery status." };
      throw new Error("Could not record the action; nothing was sent.");
    }
    const result = await sendManagerConversationSms(ctx.db, {
      actorUserId: ctx.userId,
      scopeManagerIds: [ctx.landlordId],
      vendorRecordId: vendor.recordId,
      toPhone: vendor.phone,
      text: input.message,
      // The manager's YES on the card that said "you work with this vendor" is the attestation.
      attestVendorRelationship: true,
      idempotencyKey: dedupeKey.slice("message_vendor_".length, "message_vendor_".length + 64),
      workspace: { id: ctx.workspace?.id ?? null },
    });
    const ok = result.body.ok === true;
    await updateAuditResult(ctx, dedupeKey, { status: result.body.status ?? "failed", ok }, ok ? {} : { clearDedupeKey: true });
    if (!ok) throw new Error(String(result.body.error || "The text could not be sent."));
    return {
      reply: `Text to ${vendor.name} ${result.body.status === "submitted" ? "submitted" : "queued"}.`,
      resultSummary: { outboxId: result.body.outboxId, status: result.body.status },
    };
  },
});

export const managerVendorMessageTools = [messageVendorTool];
