import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import {
  chargeDueLabel,
  type HouseholdCharge,
  type HouseholdChargeKind,
} from "@/lib/household-charges";
import { upsertManagerCharges } from "@/lib/household-charges.server";
import { formatChargeDueDateLabel } from "@/lib/payment-reminder-bootstrap";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadAllManagerRows } from "./load-manager-rows";
import { writeAuditLog, updateAuditResult } from "../audit";
import { captureSmsTestDelivery, currentSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

/** Every charge kind the site models (mirrors HouseholdChargeKind exactly). */
const CHARGE_KINDS = [
  "application_fee",
  "holding_deposit",
  "stay_total",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
  "rent",
  "utilities",
  "prorated_utilities",
  "prorated_last_month_utilities",
  "security_deposit",
  "move_in_fee",
  "other_cost",
  "payment_at_signing",
  "work_order_charge",
  "late_fee",
  "nsf_fee",
] as const satisfies readonly HouseholdChargeKind[];

/** Server-side read of the landlord's charges, scoped by manager_user_id. */
async function loadManagerCharges(ctx: AgentContext): Promise<HouseholdCharge[]> {
  return loadAllManagerRows(
    ctx,
    "portal_household_charge_records",
    (rowData) => rowData as HouseholdCharge,
  );
}

/**
 * Ownership-gated charge lookup: `charges` MUST be the landlord's own set
 * (scoped by manager_user_id at the database boundary), so a foreign or
 * unknown id simply resolves to null.
 */
function findOwnedCharge(charges: HouseholdCharge[], chargeId: string): HouseholdCharge | null {
  const id = String(chargeId ?? "").trim();
  if (!id) return null;
  return charges.find((c) => c.id === id) ?? null;
}

/** Dollar label matching stored charge rows, e.g. "$1,500.00". */
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "YYYY-MM-DD" → the display label stored on charge rows, or null if invalid. */
function dueDateLabelFromIso(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return formatChargeDueDateLabel(date);
}

/** Stable short hash for one-shot dedupe keys built from an input patch. */
export function stableInputHash(value: unknown): string {
  const s = JSON.stringify(value) ?? "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

type ChargeTarget = {
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
};

/**
 * Resolve the charge target from the landlord's own data: the resident must be
 * one of THIS landlord's approved applicants (matched by lowercased email), and
 * an explicit propertyId must be one of THIS landlord's property records. Every
 * value on the resulting charge is server-derived from those rows.
 */
async function resolveChargeTarget(
  ctx: AgentContext,
  input: { residentEmail: string; propertyId?: string },
): Promise<{ ok: true; target: ChargeTarget } | { ok: false; error: string }> {
  const email = input.residentEmail.trim().toLowerCase();
  const applications = await loadAllManagerRows(
    ctx,
    "manager_application_records",
    (rowData) => rowData as DemoApplicantRow,
  );
  const resident = applications.find(
    (r) => r.bucket === "approved" && (r.email || "").trim().toLowerCase() === email,
  );
  if (!resident) {
    return {
      ok: false,
      error: `No approved resident with email ${email} belongs to this landlord. Use list_residents to look up resident emails.`,
    };
  }

  let propertyId = resident.assignedPropertyId?.trim() || resident.propertyId?.trim() || "";
  let propertyLabel = resident.property?.trim() || "";
  const wantedPropertyId = input.propertyId?.trim();
  if (wantedPropertyId) {
    const { data, error } = await ctx.db
      .from("manager_property_records")
      .select("id, row_data, property_data")
      .eq("manager_user_id", ctx.landlordId)
      .eq("id", wantedPropertyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return {
        ok: false,
        error: `Property ${wantedPropertyId} does not belong to this landlord. Use list_properties for valid ids, or omit propertyId to use the resident's assigned property.`,
      };
    }
    const src = asObject(data.property_data) ?? asObject(data.row_data);
    propertyId = wantedPropertyId;
    propertyLabel = str(src, "title") ?? str(src, "buildingName") ?? str(src, "name") ?? propertyLabel;
  }

  return {
    ok: true,
    target: {
      residentName: resident.name?.trim() || "Resident",
      residentEmail: email,
      propertyId,
      propertyLabel,
    },
  };
}

export const createChargeTool = defineWriteTool({
  name: "create_charge",
  description:
    "Create a new pending charge (rent, deposit, fee, etc.) for one of the landlord's approved residents. Pass the resident's email from list_residents; the amount is in USD. Payment reminders auto-schedule from the landlord's automation settings.",
  inputSchema: z
    .object({
      residentEmail: z
        .string()
        .min(3)
        .describe("Email of the resident to charge (from list_residents)."),
      kind: z.enum(CHARGE_KINDS).describe("Charge category, e.g. 'rent', 'late_fee', 'other_cost'."),
      title: z.string().min(1).max(120).describe("Short human-readable charge title shown to the resident."),
      amountUsd: z.number().positive().describe("Charge amount in US dollars, e.g. 1500 or 49.99."),
      dueDate: z
        .string()
        .optional()
        .describe("Optional due date as YYYY-MM-DD. Omit to auto-set from the reminder cadence."),
      propertyId: z
        .string()
        .optional()
        .describe("Optional property id (from list_properties). Omit to use the resident's assigned property."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const resolved = await resolveChargeTarget(ctx, input);
    if (!resolved.ok) throw new Error(resolved.error);
    const { target } = resolved;

    let dueLabel: string | null = null;
    if (input.dueDate) {
      dueLabel = dueDateLabelFromIso(input.dueDate);
      if (!dueLabel) {
        throw new Error(`Invalid dueDate "${input.dueDate}" — pass a real date as YYYY-MM-DD.`);
      }
    }

    const amountLabel = formatUsd(input.amountUsd);
    return {
      confirmedInput: { ...input, residentEmail: target.residentEmail, title: input.title.trim() },
      kind: "create_charge",
      title: "Create charge",
      summary: `Create a ${amountLabel} "${input.title.trim()}" charge for ${target.residentName}.`,
      fields: [
          { label: "Resident", value: `${target.residentName} (${target.residentEmail})` },
          { label: "Property", value: target.propertyLabel || "—" },
          { label: "Charge", value: `${input.title.trim()} (${input.kind})` },
          { label: "Amount", value: amountLabel },
          { label: "Due date", value: dueLabel ?? "Auto (from the reminder cadence)" },
          { label: "Reminders", value: "Payment reminders will be scheduled automatically" },
        ],
      confirmLabel: "Create charge",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve the target from the landlord's own data at execute time —
    // stored input is never trusted as ownership proof.
    const resolved = await resolveChargeTarget(ctx, input);
    if (!resolved.ok) throw new Error(resolved.error);
    const { target } = resolved;

    const dueLabel = input.dueDate ? dueDateLabelFromIso(input.dueDate) : null;
    if (input.dueDate && !dueLabel) {
      throw new Error(`Invalid dueDate "${input.dueDate}" — pass a real date as YYYY-MM-DD.`);
    }
    const amountLabel = formatUsd(input.amountUsd);

    // 1. Record intent first, idempotently: an identical create (same resident,
    //    kind, amount, and due date) short-circuits instead of double-charging.
    const dedupeKey = `create_charge:${ctx.landlordId}:${target.residentEmail}:${input.kind}:${input.amountUsd.toFixed(2)}:${input.dueDate ?? "auto"}`;
    const audit = await writeAuditLog(ctx, {
      action: "create_charge",
      toolName: "create_charge",
      inputSummary: {
        residentEmail: target.residentEmail,
        kind: input.kind,
        amountUsd: input.amountUsd,
        dueDate: input.dueDate ?? null,
      },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "An identical charge was already created by this action — nothing new was added." };
      }
      throw new Error("Could not record the action; no charge was created.");
    }

    // Best-effort resident account link: the email was verified above to belong
    // to this landlord's approved resident, so resolving its profile id is a
    // target lookup, not a scope decision.
    const { data: profile } = await ctx.db
      .from("profiles")
      .select("id")
      .eq("email", target.residentEmail)
      .maybeSingle();
    const residentUserId = typeof profile?.id === "string" ? profile.id : null;

    const smsTest = currentSmsTestTransport();
    const charge: HouseholdCharge & { smsTestSessionId?: string } = {
      id: `hc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      residentEmail: target.residentEmail,
      residentName: target.residentName,
      residentUserId,
      propertyId: target.propertyId,
      propertyLabel: target.propertyLabel,
      managerUserId: ctx.landlordId,
      kind: input.kind,
      title: input.title.trim(),
      amountLabel,
      balanceLabel: amountLabel,
      status: "pending",
      ...(dueLabel ? { dueDateLabel: dueLabel } : {}),
      blocksLeaseUntilPaid: false,
      ...stampSmsTestProvenance({}),
    };

    try {
      await upsertManagerCharges(ctx.db, ctx.landlordId, [charge]);
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { error: "charge_upsert_failed" }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The charge could not be created.");
    }
    if (smsTest) {
      captureSmsTestDelivery({
        kind: "reminder",
        summary: "Automatic charge reminders were captured for SMS test mode.",
        status: "captured",
        metadata: { chargeId: charge.id },
      });
    }

    await updateAuditResult(ctx, dedupeKey, { chargeId: charge.id });
    return { reply: `Created a ${amountLabel} "${charge.title}" charge for ${target.residentName}${dueLabel ? ` due ${dueLabel}` : " with an automatic due date"}. Payment reminders are scheduled automatically.`, resultSummary: { chargeId: charge.id } };
  },
});

export const updateChargeTool = defineWriteTool({
  name: "update_charge",
  description:
    "Update the amount, due date, or title of one of the landlord's existing unpaid charges. Pass the charge id from list_charges or get_overdue_charges. Paid charges cannot be edited.",
  inputSchema: z
    .object({
      chargeId: z.string().min(1).describe("Id of the charge to update (from list_charges)."),
      amountUsd: z.number().positive().optional().describe("New charge amount in US dollars."),
      dueDate: z.string().optional().describe("New due date as YYYY-MM-DD."),
      title: z.string().min(1).max(120).optional().describe("New charge title."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) {
      throw new Error(`No charge with id ${input.chargeId} belongs to this landlord. Use list_charges to find valid charge ids.`);
    }
    if (charge.status === "paid") {
      throw new Error(`Charge ${charge.id} is already paid — paid charges cannot be edited.`);
    }
    if (input.amountUsd == null && input.dueDate == null && input.title == null) {
      throw new Error("Nothing to update — pass at least one of amountUsd, dueDate, or title.");
    }
    let dueLabel: string | null = null;
    if (input.dueDate) {
      dueLabel = dueDateLabelFromIso(input.dueDate);
      if (!dueLabel) {
        throw new Error(`Invalid dueDate "${input.dueDate}" — pass a real date as YYYY-MM-DD.`);
      }
    }

    // Field-diff lines, every "from" value read from the stored row.
    const lines: { label: string; value: string }[] = [];
    if (input.amountUsd != null) {
      lines.push({ label: "Amount", value: `${charge.amountLabel || "—"} → ${formatUsd(input.amountUsd)}` });
    }
    if (dueLabel) {
      lines.push({ label: "Due date", value: `${chargeDueLabel(charge)} → ${dueLabel}` });
    }
    if (input.title != null) {
      lines.push({ label: "Title", value: `${charge.title || "—"} → ${input.title.trim()}` });
    }
    return {
      confirmedInput: { ...input, ...(input.title != null ? { title: input.title.trim() } : {}) },
      kind: "update_charge",
      title: "Update charge",
      summary: `Update "${charge.title}" for ${charge.residentName || charge.residentEmail}.`,
      fields: lines,
      confirmLabel: "Update charge",
    };
  },
  handler: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) throw new Error("No charge with that id belongs to this landlord.");
    if (charge.status === "paid") throw new Error("This charge is already paid and cannot be edited.");
    if (input.amountUsd == null && input.dueDate == null && input.title == null) {
      throw new Error("Nothing to update.");
    }
    const dueLabel = input.dueDate ? dueDateLabelFromIso(input.dueDate) : null;
    if (input.dueDate && !dueLabel) throw new Error(`Invalid dueDate "${input.dueDate}".`);

    const patch = { amountUsd: input.amountUsd ?? null, dueDate: input.dueDate ?? null, title: input.title ?? null };
    const dedupeKey = `update_charge:${ctx.landlordId}:${charge.id}:${stableInputHash(patch)}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_charge",
      toolName: "update_charge",
      inputSummary: { chargeId: charge.id, fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] != null) },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That exact update was already applied to this charge." };
      throw new Error("Could not record the action; the charge was not updated.");
    }

    // Read-merge-write: start from the CURRENT stored row_data, never rebuild.
    const amountLabel = input.amountUsd != null ? formatUsd(input.amountUsd) : null;
    const smsTest = currentSmsTestTransport();
    const merged: HouseholdCharge & { smsTestSessionId?: string } = {
      ...charge,
      ...(amountLabel ? { amountLabel, balanceLabel: amountLabel } : {}),
      ...(input.title != null ? { title: input.title.trim() } : {}),
      ...(dueLabel ? { dueDateLabel: dueLabel } : {}),
      ...stampSmsTestProvenance({}),
    };
    try {
      await upsertManagerCharges(ctx.db, ctx.landlordId, [merged]);
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { error: "charge_upsert_failed" }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The charge could not be updated.");
    }
    if (smsTest) {
      captureSmsTestDelivery({
        kind: "reminder",
        summary: "Automatic charge reminders were captured for SMS test mode.",
        status: "captured",
        metadata: { chargeId: charge.id },
      });
    }

    await updateAuditResult(ctx, dedupeKey, { chargeId: charge.id });
    const changed: string[] = [];
    if (amountLabel) changed.push(`amount → ${amountLabel}`);
    if (dueLabel) changed.push(`due date → ${dueLabel}`);
    if (input.title != null) changed.push(`title → "${input.title.trim()}"`);
    return { reply: `Updated "${merged.title}" for ${merged.residentName || merged.residentEmail}: ${changed.join(", ")}.`, resultSummary: { chargeId: charge.id } };
  },
});

export const deleteChargeTool = defineWriteTool({
  name: "delete_charge",
  description:
    "Permanently delete one of the landlord's charges and its ledger entries. Pass the charge id from list_charges. Use only for charges created in error — deletion is irreversible.",
  destructive: true,
  inputSchema: z
    .object({
      chargeId: z.string().min(1).describe("Id of the charge to delete (from list_charges)."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) {
      throw new Error(`No charge with id ${input.chargeId} belongs to this landlord. Use list_charges to find valid charge ids.`);
    }
    return {
      kind: "delete_charge",
      title: "Delete charge",
      summary: `Permanently delete "${charge.title}" for ${charge.residentName || charge.residentEmail}.`,
      fields: [
          { label: "Resident", value: `${charge.residentName || "—"} (${(charge.residentEmail || "").trim().toLowerCase() || "—"})` },
          { label: "Charge", value: charge.title || "—" },
          { label: "Amount", value: charge.amountLabel || "—" },
          { label: "Status", value: charge.status || "—" },
        ],
      confirmLabel: "Delete charge",
      warnings: ["This permanently deletes the charge and its ledger entries. It cannot be undone."],
    };
  },
  handler: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) {
      throw new Error("No charge with that id belongs to this landlord (it may already be deleted).");
    }

    const dedupeKey = `delete_charge:${ctx.landlordId}:${charge.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "delete_charge",
      toolName: "delete_charge",
      inputSummary: { chargeId: charge.id, kind: charge.kind ?? null, status: charge.status ?? null },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That charge was already deleted by this action." };
      throw new Error("Could not record the action; the charge was not deleted.");
    }

    // Ledger entries first (the legacy route path leaks these as orphans);
    // both deletes are scoped to the landlord so a shared/forged id can never
    // touch another landlord's rows.
    const { error: ledgerError } = await ctx.db
      .from("ledger_entries")
      .delete()
      .eq("manager_user_id", ctx.landlordId)
      .eq("source_charge_id", charge.id);
    if (ledgerError) {
      await updateAuditResult(ctx, dedupeKey, { error: "ledger_delete_failed" }, { clearDedupeKey: true });
      throw new Error(`Could not delete the charge's ledger entries: ${ledgerError.message}`);
    }
    const { error: chargeError } = await ctx.db
      .from("portal_household_charge_records")
      .delete()
      .eq("manager_user_id", ctx.landlordId)
      .eq("id", charge.id);
    if (chargeError) {
      await updateAuditResult(ctx, dedupeKey, { error: "charge_delete_failed" }, { clearDedupeKey: true });
      throw new Error(`Could not delete the charge: ${chargeError.message}`);
    }

    await updateAuditResult(ctx, dedupeKey, { chargeId: charge.id, deleted: true });
    return { reply: `Deleted "${charge.title}" (${charge.amountLabel || "no amount"}) for ${charge.residentName || charge.residentEmail} and removed its ledger entries.`, resultSummary: { chargeId: charge.id } };
  },
});

const MANUAL_CHANNELS = ["cash", "check", "other"] as const;

export const markChargePaidTool = defineWriteTool({
  name: "mark_charge_paid",
  description:
    "Record that a resident paid one of the landlord's charges outside PropLane (cash or check). Pass the charge id from list_charges; this cancels the charge's future payment reminders and records the payment in the ledger.",
  inputSchema: z
    .object({
      chargeId: z.string().min(1).describe("Id of the unpaid charge to mark paid (from list_charges)."),
      channel: z
        .enum(MANUAL_CHANNELS)
        .optional()
        .describe("Optional payment method the resident used, for the record."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) {
      throw new Error(`No charge with id ${input.chargeId} belongs to this landlord. Use list_charges to find valid charge ids.`);
    }
    if (charge.status === "paid") {
      throw new Error(`Charge ${charge.id} is already marked paid.`);
    }
    const lines: { label: string; value: string }[] = [
      { label: "Resident", value: `${charge.residentName || "—"} (${(charge.residentEmail || "").trim().toLowerCase() || "—"})` },
      { label: "Charge", value: charge.title || "—" },
      { label: "Amount", value: charge.balanceLabel || charge.amountLabel || "—" },
    ];
    if (input.channel) lines.push({ label: "Payment method", value: input.channel });
    lines.push({ label: "Effect", value: "Future reminders cancelled; payment recorded in the ledger" });
    return {
      kind: "mark_charge_paid",
      title: "Mark charge paid",
      summary: `Mark "${charge.title}" (${charge.balanceLabel || charge.amountLabel}) for ${charge.residentName || charge.residentEmail} as paid.`,
      fields: lines,
      confirmLabel: "Mark paid",
    };
  },
  handler: async (ctx, input) => {
    const charge = findOwnedCharge(await loadManagerCharges(ctx), input.chargeId);
    if (!charge) throw new Error("No charge with that id belongs to this landlord.");
    if (charge.status === "paid") throw new Error("This charge is already marked paid.");

    // One-shot transition: marking the same charge paid twice returns already-done.
    const dedupeKey = `mark_charge_paid:${ctx.landlordId}:${charge.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "mark_charge_paid",
      toolName: "mark_charge_paid",
      inputSummary: { chargeId: charge.id, channel: input.channel ?? null },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That charge was already marked paid by this action." };
      throw new Error("Could not record the action; the charge was not marked paid.");
    }

    // Read-merge-write on the current row (same shape markHouseholdChargePaid
    // writes); upsertManagerCharges handles the paid transition — cancelling
    // future reminders and writing the charge + payment ledger entries.
    const merged: HouseholdCharge = {
      ...charge,
      status: "paid",
      paidAt: new Date().toISOString(),
      balanceLabel: "$0.00",
    };
    try {
      await upsertManagerCharges(ctx.db, ctx.landlordId, [merged]);
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { error: "charge_upsert_failed" }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The charge could not be marked paid.");
    }

    await updateAuditResult(ctx, dedupeKey, { chargeId: charge.id, channel: input.channel ?? null, paid: true });
    return { reply: `Marked "${charge.title}" (${charge.amountLabel}) for ${charge.residentName || charge.residentEmail} as paid${input.channel ? ` via ${input.channel}` : ""}. Future reminders were cancelled and the payment was recorded in the ledger.`, resultSummary: { chargeId: charge.id, channel: input.channel ?? null } };
  },
});
