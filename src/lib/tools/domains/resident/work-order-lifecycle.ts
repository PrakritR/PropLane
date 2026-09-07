/**
 * Resident work-order lifecycle from chat (PRP-268): edit, cancel, and nudge
 * the manager on one of the resident's OWN maintenance requests — the three
 * things the Services panel's `WorkOrderDetail` offers while a request is still
 * open. Each tool goes through `resident-work-order-lifecycle.server.ts` /
 * `resident-work-order-reminder.server.ts`, the same server code the panel's
 * routes run, so chat can never do something the portal would refuse.
 *
 * `portal_work_order_records` carries ONLY `resident_email` (no
 * `resident_user_id`), so every lookup here scopes on that column via
 * `loadResidentOwnWorkOrder`; the id the model passes is a target, never proof.
 */
import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../../audit";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { deliverResidentWorkOrderReminder } from "@/lib/resident-work-order-reminder.server";
import {
  applyResidentWorkOrderPatch,
  cancelResidentWorkOrder,
  loadResidentOwnWorkOrder,
  normalizePreferredArrival,
  RESIDENT_WORK_ORDER_PRIORITIES,
  residentWorkOrderClosedReason,
  residentWorkOrderIsOpen,
  residentWorkOrderReminderCooldownRemainingMs,
  updateResidentWorkOrder,
  type ResidentWorkOrderPatch,
  type ResidentWorkOrderRecord,
} from "@/lib/resident-work-order-lifecycle.server";
import { entryPermissionLabel } from "@/lib/work-order-entry";
import { contentHash, linkedManagerContacts } from "./load-resident-rows";

const NOT_YOURS = "That is not one of your maintenance requests. Use list_my_work_orders to get valid ids.";

/** Load the resident's own row, or throw the model-facing refusal. */
async function requireOwnWorkOrder(ctx: ResidentAgentContext, workOrderId: string): Promise<ResidentWorkOrderRecord> {
  const record = await loadResidentOwnWorkOrder(ctx.db, {
    workOrderId,
    residentEmail: ctx.email,
    activeManagerId: ctx.activeManagerId,
  });
  if (!record) throw new Error(NOT_YOURS);
  return record;
}

/** Load the resident's own OPEN row, or throw why it can no longer be changed. */
async function requireOpenOwnWorkOrder(ctx: ResidentAgentContext, workOrderId: string): Promise<ResidentWorkOrderRecord> {
  const record = await requireOwnWorkOrder(ctx, workOrderId);
  if (!residentWorkOrderIsOpen(record.row_data)) throw new Error(residentWorkOrderClosedReason(record.row_data));
  return record;
}

function requestLabel(row: DemoManagerWorkOrderRow): string {
  const title = row.title?.trim() || "Maintenance request";
  return row.reference?.trim() ? `${title} (${row.reference.trim()})` : title;
}

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const property = row.propertyName?.trim() || "Your property";
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${property} · ${unit}` : property;
}

async function managerLabel(ctx: ResidentAgentContext, managerUserId: string | null): Promise<string> {
  if (!managerUserId) return "your property manager";
  const contact = (await linkedManagerContacts(ctx)).find((c) => c.id === managerUserId);
  return contact ? `${contact.name} (${contact.email})` : "your property manager";
}

function formatNudgeStamp(iso: string | undefined): string {
  const ts = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ts)) return "Never";
  return `${formatPacificDateTime(new Date(ts))} PT`;
}

function hoursLabel(ms: number): string {
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// update_work_order
// ---------------------------------------------------------------------------

const updateWorkOrderSchema = z
  .object({
    workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
    title: z.string().min(1).max(160).optional().describe("New short summary of the issue."),
    description: z.string().min(1).max(2000).optional().describe("New details describing the issue."),
    priority: z
      .enum(RESIDENT_WORK_ORDER_PRIORITIES)
      .optional()
      .describe("New urgency: Emergency, Low, Medium, or High."),
    preferredArrival: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "New preferred visit window: 'Anytime', 'Weekday mornings', 'Weekday afternoons', 'After 5pm weekdays', 'Weekends only', or a custom window in the resident's words.",
      ),
    entryPermission: z
      .enum(["allowed", "call_first", "resident_present"])
      .optional()
      .describe("Whether the repair person may enter when the resident is out: allowed, call_first, or resident_present."),
    entryNotes: z
      .string()
      .max(500)
      .optional()
      .describe("Access notes (gate code, pets, parking). Pass an empty string to clear them."),
  })
  .strict();

type UpdateWorkOrderInput = z.infer<typeof updateWorkOrderSchema>;

const PATCH_KEYS = ["title", "description", "priority", "preferredArrival", "entryPermission", "entryNotes"] as const;

function patchFromInput(input: UpdateWorkOrderInput): ResidentWorkOrderPatch {
  const patch: ResidentWorkOrderPatch = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  return patch;
}

/** Card fields for the values that will change, each shown as what it becomes. */
function changedFields(current: DemoManagerWorkOrderRow, patch: ResidentWorkOrderPatch): { label: string; value: string }[] {
  const next = applyResidentWorkOrderPatch(current, patch);
  const fields: { label: string; value: string }[] = [];
  if (patch.title !== undefined) fields.push({ label: "Title", value: next.title });
  if (patch.description !== undefined) fields.push({ label: "Details", value: next.description });
  if (patch.priority !== undefined) fields.push({ label: "Priority", value: next.priority });
  if (patch.preferredArrival !== undefined) {
    fields.push({ label: "Preferred visit window", value: normalizePreferredArrival(patch.preferredArrival) });
  }
  if (patch.entryPermission !== undefined) {
    fields.push({ label: "Entry if you're not home", value: entryPermissionLabel(next.entryPermission) });
  }
  if (patch.entryNotes !== undefined) fields.push({ label: "Entry notes", value: next.entryNotes ?? "(cleared)" });
  return fields;
}

export const updateWorkOrderTool = defineWriteTool({
  name: "update_work_order",
  description:
    "Edit one of the resident's own OPEN maintenance requests — the same fields as the portal's Edit service form: title, details, priority, preferred visit window, entry permission, and entry notes. Only pass the fields that change. Cannot edit a request the manager has already scheduled or completed. Pass the id from list_my_work_orders.",
  inputSchema: updateWorkOrderSchema,
  preview: async (ctx: ResidentAgentContext, input) => {
    const patch = patchFromInput(input);
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to change — pass at least one of title, description, priority, preferredArrival, entryPermission, or entryNotes.");
    }
    const record = await requireOpenOwnWorkOrder(ctx, input.workOrderId.trim());
    const current = record.row_data;
    const changes = changedFields(current, patch);
    return {
      kind: "update_work_order",
      title: "Update maintenance request",
      summary: `Update "${requestLabel(current)}" — ${changes.length} field${changes.length === 1 ? "" : "s"} will change.`,
      confirmLabel: "Save changes",
      fields: [
        { label: "Request", value: requestLabel(current) },
        { label: "Property", value: propertyLabel(current) },
        ...changes,
      ],
      warnings: ["Your property manager sees these changes on the request."],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const workOrderId = input.workOrderId.trim();
    const patch = patchFromInput(input);
    if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");
    // Re-resolve ownership + openness from live data; the stored input is never proof.
    await requireOpenOwnWorkOrder(ctx, workOrderId);

    // Same patch on the same request on the same day is a replayed confirm,
    // not a second edit; a genuinely new edit hashes differently.
    const patchHash = contentHash(JSON.stringify(patch));
    const dedupeKey = `update_work_order:${ctx.landlordId}:${workOrderId}:${patchHash}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_work_order",
      toolName: "update_work_order",
      inputSummary: { workOrderId, fields: Object.keys(patch), patchHash },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those changes were already saved to this request." };
      throw new Error("Could not record the action; the request was not changed.");
    }

    const result = await updateResidentWorkOrder(
      ctx.db,
      { workOrderId, residentEmail: ctx.email, activeManagerId: ctx.activeManagerId },
      patch,
    );
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { failed: true, code: result.code }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { workOrderId, fields: Object.keys(patch) });
    return {
      reply: `Updated "${requestLabel(result.row)}". Your property manager will see the new details under Services.`,
      resultSummary: { workOrderId, fields: Object.keys(patch) },
    };
  },
});

// ---------------------------------------------------------------------------
// cancel_work_order
// ---------------------------------------------------------------------------

export const cancelWorkOrderTool = defineWriteTool({
  name: "cancel_work_order",
  description:
    "Cancel one of the resident's own OPEN maintenance requests (the portal's Cancel service action). This REMOVES the request and cannot be undone. Cannot cancel a request the manager has already scheduled or completed. Pass the id from list_my_work_orders.",
  destructive: true,
  inputSchema: z
    .object({
      workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
    })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    const record = await requireOpenOwnWorkOrder(ctx, input.workOrderId.trim());
    const row = record.row_data;
    return {
      kind: "cancel_work_order",
      title: "Cancel maintenance request",
      summary: `Cancel "${requestLabel(row)}" at ${propertyLabel(row)}.`,
      confirmLabel: "Cancel request",
      fields: [
        { label: "Request", value: requestLabel(row) },
        { label: "Property", value: propertyLabel(row) },
        { label: "Status", value: row.status?.trim() || "Open" },
        { label: "Details", value: row.description?.trim() || "—" },
      ],
      warnings: [
        "This removes the request from your Services list and cannot be undone.",
        "Your property manager will no longer see it. File a new request if the issue comes back.",
      ],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const workOrderId = input.workOrderId.trim();
    const record = await requireOpenOwnWorkOrder(ctx, workOrderId);

    // One-shot transition: a replayed confirm reports "already cancelled" forever.
    const dedupeKey = `cancel_work_order:${ctx.landlordId}:${workOrderId}`;
    const audit = await writeAuditLog(ctx, {
      action: "cancel_work_order",
      toolName: "cancel_work_order",
      inputSummary: { workOrderId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That request was already cancelled." };
      throw new Error("Could not record the action; the request was not cancelled.");
    }

    const result = await cancelResidentWorkOrder(ctx.db, {
      workOrderId,
      residentEmail: ctx.email,
      activeManagerId: ctx.activeManagerId,
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { failed: true, code: result.code }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { workOrderId, cancelled: true });
    return {
      reply: `Cancelled "${requestLabel(record.row_data)}". It no longer appears under Services.`,
      resultSummary: { workOrderId, cancelled: true },
    };
  },
});

// ---------------------------------------------------------------------------
// nudge_manager_on_work_order
// ---------------------------------------------------------------------------

export const nudgeManagerOnWorkOrderTool = defineWriteTool({
  name: "nudge_manager_on_work_order",
  description:
    "Send the resident's property manager a reminder about one of the resident's own OPEN maintenance requests (the portal's Send reminder action). Delivered to the manager's PropLane inbox and email. Allowed once per request every 24 hours; use list_my_work_orders for the id.",
  inputSchema: z
    .object({
      workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
    })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    const record = await requireOpenOwnWorkOrder(ctx, input.workOrderId.trim());
    const row = record.row_data;
    const cooldownMs = residentWorkOrderReminderCooldownRemainingMs(row);
    if (cooldownMs > 0) {
      throw new Error(
        `You already nudged your manager about "${requestLabel(row)}" on ${formatNudgeStamp(row.residentReminderSentAt)}. You can send another reminder in ${hoursLabel(cooldownMs)}.`,
      );
    }
    const manager = await managerLabel(ctx, record.manager_user_id);
    return {
      kind: "nudge_manager_on_work_order",
      title: "Remind your property manager",
      summary: `Send ${manager} a reminder about "${requestLabel(row)}".`,
      confirmLabel: "Send reminder",
      fields: [
        { label: "Request", value: requestLabel(row) },
        { label: "Property", value: propertyLabel(row) },
        { label: "Reminding", value: manager },
        { label: "Last reminder", value: formatNudgeStamp(row.residentReminderSentAt) },
      ],
      warnings: ["Reminders are limited to one per request every 24 hours."],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const workOrderId = input.workOrderId.trim();
    const record = await requireOpenOwnWorkOrder(ctx, workOrderId);
    const cooldownMs = residentWorkOrderReminderCooldownRemainingMs(record.row_data);
    if (cooldownMs > 0) {
      throw new Error(`You can send another reminder about this request in ${hoursLabel(cooldownMs)}.`);
    }

    // Repeatable send: one audit row per request per day, matching the
    // 24-hour cooldown the reminder path enforces on the row itself.
    const dedupeKey = `nudge_manager_on_work_order:${ctx.landlordId}:${workOrderId}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "nudge_manager_on_work_order",
      toolName: "nudge_manager_on_work_order",
      inputSummary: { workOrderId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "You already sent a reminder about that request today." };
      throw new Error("Could not record the action; no reminder was sent.");
    }

    // The same delivery the Services panel's Send reminder button posts to
    // (/api/portal/work-orders/send-reminder): it re-checks ownership,
    // manager linkage, openness, and the cooldown, then notifies and stamps
    // residentReminderSentAt on the row.
    const result = await deliverResidentWorkOrderReminder(ctx.db, {
      workOrderId,
      residentUserId: ctx.userId,
      residentEmail: ctx.email,
      residentName: record.row_data.residentName?.trim() || "",
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { failed: true }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { workOrderId, recipientCount: result.recipientCount });
    return {
      reply: `Sent your property manager a reminder about "${requestLabel(record.row_data)}". You can send another in 24 hours.`,
      resultSummary: { workOrderId, recipientCount: result.recipientCount },
    };
  },
});
