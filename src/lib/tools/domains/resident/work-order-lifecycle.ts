/**
 * Resident work-order lifecycle — the three actions the Services screen already
 * offers on an OPEN maintenance request (`resident-services-panel.tsx`:
 * "Edit service", "Cancel service", "Send reminder"), exposed to the resident
 * assistant as gated writes (PRP-268).
 *
 * Parity with the screen is the contract:
 *  - only a request still in the `open` bucket can be edited, cancelled or
 *    nudged — once the manager has scheduled or completed it, the buttons
 *    disappear there and the tools refuse here;
 *  - editing rewrites the same fields the edit dialog does and nothing else;
 *  - cancelling removes the record, exactly as "Cancel service" does (the
 *    manager's calendar entry is released the same way the route releases it);
 *  - nudging goes through `deliverResidentWorkOrderReminder`, the one server
 *    function `/api/portal/work-orders/send-reminder` uses, so ownership,
 *    the 24-hour cooldown and recipient routing cannot drift between the
 *    button and the assistant.
 *
 * Every read is scoped by `resident_email` (the only identity column this
 * table carries — see `load-resident-rows.ts`), and every handler re-resolves
 * the row at confirm time; the stored id is a request, never ownership proof.
 */
import { z } from "zod";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { SERVICE_INTAKE_PRIORITY_OPTIONS } from "@/lib/service-intake";
import { RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS } from "@/lib/resident-work-order-reminder-email";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../../audit";
import { contentHash } from "./load-resident-rows";

type OwnWorkOrderRecord = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  row_data: DemoManagerWorkOrderRow;
};

const ENTRY_PERMISSION_LABEL: Record<NonNullable<DemoManagerWorkOrderRow["entryPermission"]>, string> = {
  allowed: "May enter if I'm not home",
  call_first: "Call before entering",
  resident_present: "Only while I'm present",
};

function workOrderLabel(row: DemoManagerWorkOrderRow): string {
  const ref = row.reference?.trim();
  const title = row.title?.trim() || "Maintenance request";
  return ref ? `${title} (${ref})` : title;
}

/**
 * The resident's own work order, or null. Scoped exactly like the list tool
 * (`resident_email`, plus the texted manager for SMS sessions), so an id that
 * belongs to anyone else resolves to "not yours" rather than to a row.
 */
async function loadOwnWorkOrder(ctx: ResidentAgentContext, workOrderId: string): Promise<OwnWorkOrderRecord | null> {
  const id = workOrderId.trim();
  if (!id || !ctx.email?.trim()) return null;
  let query = ctx.db
    .from("portal_work_order_records")
    .select("id, manager_user_id, resident_email, property_id, assigned_property_id, row_data")
    .eq("id", id)
    .eq("resident_email", ctx.email);
  if (ctx.activeManagerId) query = query.eq("manager_user_id", ctx.activeManagerId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.row_data || typeof data.row_data !== "object") return null;
  return data as OwnWorkOrderRecord;
}

/** Same rule as the screen's `canModify`: only an open request can change. */
function isOpen(row: DemoManagerWorkOrderRow): boolean {
  return row.bucket === "open";
}

function notYours(id: string): Error {
  return new Error(`${id} is not one of your maintenance requests. Use list_my_work_orders to get valid ids.`);
}

function notOpen(row: DemoManagerWorkOrderRow, verb: string): Error {
  return new Error(
    `"${workOrderLabel(row)}" is ${String(row.status || row.bucket || "no longer open").toLowerCase()}, so it can't be ${verb} any more. Message your manager instead.`,
  );
}

/** Ms of reminder cooldown left on a row, 0 when a reminder may be sent now. */
export function reminderCooldownRemainingMs(row: DemoManagerWorkOrderRow, now = Date.now()): number {
  const sentAt = row.residentReminderSentAt?.trim();
  if (!sentAt) return 0;
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return 0;
  const elapsed = now - ts;
  return elapsed >= RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS ? 0 : RESIDENT_WORK_ORDER_REMINDER_COOLDOWN_MS - elapsed;
}

/* ------------------------------------------------------------------------ */
/* update_work_order                                                        */
/* ------------------------------------------------------------------------ */

const updateWorkOrderSchema = z
  .object({
    workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
    title: z.string().min(1).max(200).optional().describe("New short title for the request."),
    description: z.string().min(1).max(2000).optional().describe("New description of what is wrong."),
    priority: z
      .enum(SERVICE_INTAKE_PRIORITY_OPTIONS)
      .optional()
      .describe("New priority: Emergency, High, Medium or Low."),
    preferredArrival: z
      .string()
      .max(200)
      .optional()
      .describe("When maintenance may come by, in the resident's words (e.g. 'weekday mornings', 'after 5pm')."),
    entryPermission: z
      .enum(["allowed", "call_first", "resident_present"])
      .optional()
      .describe("Whether the repair person may enter when the resident is not home."),
    entryNotes: z.string().max(500).optional().describe("Access notes for the repair person (gate code, pets, etc.)."),
  })
  .strict()
  .refine(
    (input) =>
      [input.title, input.description, input.priority, input.preferredArrival, input.entryPermission, input.entryNotes].some(
        (value) => value !== undefined,
      ),
    { message: "Say what should change: title, description, priority, preferredArrival, entryPermission or entryNotes." },
  );

type UpdateWorkOrderInput = z.infer<typeof updateWorkOrderSchema>;

/** The row after the requested edits — the same fields the edit dialog writes. */
function applyWorkOrderEdits(current: DemoManagerWorkOrderRow, input: UpdateWorkOrderInput): DemoManagerWorkOrderRow {
  const next: DemoManagerWorkOrderRow = { ...current };
  if (input.title !== undefined) next.title = input.title.trim() || current.title;
  if (input.description !== undefined) next.description = input.description.trim() || current.description;
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.preferredArrival !== undefined) next.preferredArrival = input.preferredArrival.trim() || undefined;
  if (input.entryPermission !== undefined) next.entryPermission = input.entryPermission;
  if (input.entryNotes !== undefined) next.entryNotes = input.entryNotes.trim() || undefined;
  return next;
}

function changedFields(current: DemoManagerWorkOrderRow, next: DemoManagerWorkOrderRow): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  const show = (label: string, before: string | undefined, after: string | undefined) => {
    if ((before ?? "") === (after ?? "")) return;
    fields.push({ label, value: `${before?.trim() || "—"} → ${after?.trim() || "—"}` });
  };
  show("Title", current.title, next.title);
  show("Description", current.description, next.description);
  show("Priority", current.priority, next.priority);
  show("Preferred arrival", current.preferredArrival, next.preferredArrival);
  show(
    "Entry permission",
    current.entryPermission ? ENTRY_PERMISSION_LABEL[current.entryPermission] : undefined,
    next.entryPermission ? ENTRY_PERMISSION_LABEL[next.entryPermission] : undefined,
  );
  show("Entry notes", current.entryNotes, next.entryNotes);
  return fields;
}

export const updateWorkOrderTool = defineWriteTool({
  name: "update_work_order",
  description:
    "Edit one of the resident's own OPEN maintenance requests — the portal's Services -> Edit service action. Can change the title, description, priority, preferred arrival window, entry permission and access notes. Pass the id from list_my_work_orders. A request the manager has already scheduled or completed cannot be edited.",
  inputSchema: updateWorkOrderSchema,
  preview: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    if (!isOpen(record.row_data)) throw notOpen(record.row_data, "edited");
    const next = applyWorkOrderEdits(record.row_data, input);
    const fields = changedFields(record.row_data, next);
    if (fields.length === 0) {
      throw new Error(`"${workOrderLabel(record.row_data)}" already has those values — nothing to change.`);
    }
    return {
      kind: "update_work_order",
      title: "Update maintenance request",
      summary: `Update "${workOrderLabel(record.row_data)}".`,
      confirmLabel: "Save changes",
      fields: [{ label: "Request", value: workOrderLabel(record.row_data) }, ...fields],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    if (!isOpen(record.row_data)) throw notOpen(record.row_data, "edited");
    const next = applyWorkOrderEdits(record.row_data, input);
    const fields = changedFields(record.row_data, next);
    if (fields.length === 0) {
      return { reply: `"${workOrderLabel(record.row_data)}" already has those values — nothing changed.` };
    }

    // One-shot per exact patch: confirming the same edit twice is a no-op.
    const patchHash = contentHash(JSON.stringify(fields));
    const dedupeKey = `update_work_order:${ctx.landlordId}:${record.id}:${patchHash}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_work_order",
      toolName: "update_work_order",
      inputSummary: { workOrderId: record.id, changed: fields.map((f) => f.label), patchHash },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those changes were already saved." };
      throw new Error("Could not record the action; the request was not changed.");
    }

    // Read-merge-write the CURRENT row_data, keeping every scope column the
    // route stamps (the email is the resident's own, never rewritten here).
    const { error } = await ctx.db.from("portal_work_order_records").upsert(
      {
        id: record.id,
        manager_user_id: record.manager_user_id,
        resident_email: record.resident_email,
        property_id: record.property_id,
        assigned_property_id: record.assigned_property_id,
        row_data: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { failed: true }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { changed: fields.map((f) => f.label) });
    return {
      reply: `Updated "${workOrderLabel(next)}" (${fields.map((f) => f.label.toLowerCase()).join(", ")}).`,
    };
  },
});

/* ------------------------------------------------------------------------ */
/* cancel_work_order                                                        */
/* ------------------------------------------------------------------------ */

const cancelWorkOrderSchema = z
  .object({
    workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
  })
  .strict();

export const cancelWorkOrderTool = defineWriteTool({
  name: "cancel_work_order",
  description:
    "Cancel one of the resident's own OPEN maintenance requests — the portal's Services -> Cancel service action. This removes the request for good; use it when the problem is resolved or was filed by mistake. Pass the id from list_my_work_orders. A request the manager has already scheduled or completed cannot be cancelled here.",
  inputSchema: cancelWorkOrderSchema,
  destructive: true,
  preview: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    if (!isOpen(record.row_data)) throw notOpen(record.row_data, "cancelled");
    const row = record.row_data;
    return {
      kind: "cancel_work_order",
      title: "Cancel maintenance request",
      summary: `Cancel "${workOrderLabel(row)}".`,
      confirmLabel: "Cancel request",
      fields: [
        { label: "Request", value: workOrderLabel(row) },
        { label: "Property", value: [row.propertyName, row.unit].filter(Boolean).join(" · ") || "—" },
        { label: "Status", value: row.status || "Open" },
      ],
      warnings: ["This removes the request permanently. File a new one if the problem comes back."],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    if (!isOpen(record.row_data)) throw notOpen(record.row_data, "cancelled");

    const dedupeKey = `cancel_work_order:${ctx.landlordId}:${record.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "cancel_work_order",
      toolName: "cancel_work_order",
      inputSummary: { workOrderId: record.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That request was already cancelled." };
      throw new Error("Could not record the action; the request was not cancelled.");
    }

    // Same release the route performs on delete: a synced calendar entry is
    // closed out before the row goes. Best effort, exactly as there.
    const managerUserId = record.manager_user_id?.trim() || record.row_data.managerUserId?.trim() || "";
    if (managerUserId) {
      const { syncWorkOrderToGoogleCalendar } = await import("@/lib/google-calendar/sync.server");
      await syncWorkOrderToGoogleCalendar(ctx.db, managerUserId, {
        ...record.row_data,
        bucket: "completed",
        scheduledAtIso: undefined,
      }).catch(() => undefined);
    }

    const { error } = await ctx.db
      .from("portal_work_order_records")
      .delete()
      .eq("id", record.id)
      .eq("resident_email", ctx.email);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { failed: true }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { cancelled: true });
    return { reply: `Cancelled "${workOrderLabel(record.row_data)}". It no longer appears under Services.` };
  },
});

/* ------------------------------------------------------------------------ */
/* nudge_manager_on_work_order                                              */
/* ------------------------------------------------------------------------ */

const nudgeSchema = z
  .object({
    workOrderId: z.string().min(1).describe("Id of your maintenance request (from list_my_work_orders)."),
  })
  .strict();

function hoursLabel(ms: number): string {
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export const nudgeManagerOnWorkOrderTool = defineWriteTool({
  name: "nudge_manager_on_work_order",
  description:
    "Send the property manager a reminder about one of the resident's own OPEN maintenance requests that has not been scheduled yet — the portal's Services -> Send reminder action. One reminder per request per 24 hours. Pass the id from list_my_work_orders.",
  inputSchema: nudgeSchema,
  preview: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    const row = record.row_data;
    if (!isOpen(row)) throw notOpen(row, "reminded about");
    const cooldown = reminderCooldownRemainingMs(row);
    if (cooldown > 0) {
      throw new Error(
        `A reminder about "${workOrderLabel(row)}" was sent recently. You can send another in about ${hoursLabel(cooldown)}.`,
      );
    }
    return {
      kind: "nudge_manager_on_work_order",
      title: "Remind your manager",
      summary: `Remind your property manager about "${workOrderLabel(row)}".`,
      confirmLabel: "Send reminder",
      fields: [
        { label: "Request", value: workOrderLabel(row) },
        { label: "Property", value: [row.propertyName, row.unit].filter(Boolean).join(" · ") || "—" },
        { label: "Filed as", value: row.priority || "Medium" },
      ],
      warnings: ["Your manager gets an inbox message and email right away. You can send one reminder per day."],
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const record = await loadOwnWorkOrder(ctx, input.workOrderId);
    if (!record) throw notYours(input.workOrderId);
    if (!isOpen(record.row_data)) throw notOpen(record.row_data, "reminded about");

    // Repeatable send: one per request per day, on top of the helper's own
    // 24-hour cooldown, so a double confirm never sends twice.
    const dedupeKey = `nudge_manager_on_work_order:${ctx.landlordId}:${record.id}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "nudge_manager_on_work_order",
      toolName: "nudge_manager_on_work_order",
      inputSummary: { workOrderId: record.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "You already reminded your manager about that request today." };
      throw new Error("Could not record the action; no reminder was sent.");
    }

    // The same server function the Send reminder button calls: it re-checks
    // ownership and residency, enforces the cooldown, routes to every manager
    // on that property, and stamps `residentReminderSentAt`.
    const { deliverResidentWorkOrderReminder } = await import("@/lib/resident-work-order-reminder.server");
    const result = await deliverResidentWorkOrderReminder(ctx.db, {
      workOrderId: record.id,
      residentUserId: ctx.userId,
      residentEmail: ctx.email,
      residentName: record.row_data.residentName?.trim() || "",
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { sent: false, error: result.error }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { sent: true, recipientCount: result.recipientCount });

    // Same funnel event the route emits, so the two paths count as one.
    const { track } = await import("@/lib/analytics/posthog");
    track("resident_work_order_reminder_sent", ctx.userId, {
      work_order_id: record.id,
      recipient_count: result.recipientCount,
      via: "assistant",
    });

    return {
      reply: `Reminder sent to your property manager about "${workOrderLabel(record.row_data)}".`,
    };
  },
});

export const residentWorkOrderLifecycleTools = [updateWorkOrderTool, cancelWorkOrderTool, nudgeManagerOnWorkOrderTool];
