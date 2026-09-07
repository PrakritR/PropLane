/**
 * PRP-268 — the resident assistant can edit, cancel and nudge the manager on
 * the resident's OWN open maintenance requests, with the same limits as the
 * Services screen: another resident's row is never actionable, a request the
 * manager has scheduled or completed refuses all three, and each action is
 * audited under its own dedupe key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditDayBucket } from "@/lib/tools/audit";
import {
  cancelWorkOrderTool,
  nudgeManagerOnWorkOrderTool,
  reminderCooldownRemainingMs,
  updateWorkOrderTool,
} from "@/lib/tools/domains/resident/work-order-lifecycle";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

const deliverReminder = vi.fn();
const syncCalendar = vi.fn(async (_db: unknown, _manager: string, row: Record<string, unknown>) => row);
const track = vi.fn();

vi.mock("@/lib/resident-work-order-reminder.server", () => ({
  deliverResidentWorkOrderReminder: (...args: unknown[]) => deliverReminder(...args),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: (...args: [unknown, string, Record<string, unknown>]) => syncCalendar(...args),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: (...args: unknown[]) => track(...args) }));

const RES_A = { id: "resident_a", email: "resa@axis.test" };
const RES_B = { id: "resident_b", email: "resb@axis.test" };
const MANAGER = "manager_1";

function workOrder(owner: { email: string }, id: string, extra: Record<string, unknown> = {}): FakeRow {
  return {
    id,
    manager_user_id: MANAGER,
    resident_email: owner.email,
    property_id: "prop_1",
    assigned_property_id: null,
    row_data: {
      id,
      reference: `WO-${id}`,
      propertyName: "Maple House",
      unit: "2B",
      title: "Leaking sink",
      priority: "Medium",
      status: "Open",
      bucket: "open",
      description: "Kitchen sink drips under the cabinet.",
      scheduled: "",
      cost: "",
      residentName: "Res A",
      residentEmail: owner.email,
      managerUserId: MANAGER,
      entryPermission: "call_first",
      ...extra,
    },
  };
}

function seed() {
  return makeResidentToolCtx({
    portal_work_order_records: [
      workOrder(RES_A, "WO-A"),
      workOrder(RES_A, "WO-A-SCHEDULED", { bucket: "scheduled", status: "Scheduled" }),
      workOrder(RES_A, "WO-A-REMINDED", { residentReminderSentAt: new Date().toISOString() }),
      workOrder(RES_B, "WO-B"),
    ],
  });
}

beforeEach(() => {
  deliverReminder.mockReset();
  deliverReminder.mockResolvedValue({ ok: true, recipientCount: 2 });
  syncCalendar.mockClear();
  track.mockClear();
});

describe("registry", () => {
  it("registers all three lifecycle tools as resident writes", () => {
    for (const name of ["update_work_order", "cancel_work_order", "nudge_manager_on_work_order"]) {
      const tool = residentAgentRegistry.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.kind).toBe("write");
      expect(typeof tool?.preview).toBe("function");
    }
    expect(residentAgentRegistry.get("cancel_work_order")?.destructive).toBe(true);
  });
});

describe("scope: another resident's request is never actionable", () => {
  it("update_work_order refuses WO-B in preview and execute, touching nothing", async () => {
    const { ctx, mutations } = seed();
    const preview = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-B", title: "Hijack" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/not one of your/i);
    const exec = await executeWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-B", title: "Hijack" });
    expect(exec.ok).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("cancel_work_order refuses WO-B and deletes nothing", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-B" });
    expect(exec.ok).toBe(false);
    expect(mutations).toEqual([]);
    expect(tables.portal_work_order_records!.some((r) => r.id === "WO-B")).toBe(true);
  });

  it("nudge_manager_on_work_order refuses WO-B and never reaches the reminder helper", async () => {
    const { ctx } = seed();
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-B" });
    expect(exec.ok).toBe(false);
    expect(deliverReminder).not.toHaveBeenCalled();
  });
});

describe("only an OPEN request can change (same rule as the screen)", () => {
  it("refuses a scheduled request for all three tools", async () => {
    const { ctx } = seed();
    const id = "WO-A-SCHEDULED";
    for (const [tool, input] of [
      [updateWorkOrderTool, { workOrderId: id, priority: "High" }],
      [cancelWorkOrderTool, { workOrderId: id }],
      [nudgeManagerOnWorkOrderTool, { workOrderId: id }],
    ] as const) {
      const preview = await previewWrite(tool, ctx, input);
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.error).toMatch(/scheduled/i);
    }
  });
});

describe("update_work_order", () => {
  it("previews only the fields that actually change", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(updateWorkOrderTool, ctx, {
      workOrderId: "WO-A",
      priority: "High",
      entryPermission: "allowed",
      title: "Leaking sink", // unchanged
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const labels = preview.preview.fields.map((f) => f.label);
    expect(labels).toContain("Priority");
    expect(labels).toContain("Entry permission");
    expect(labels).not.toContain("Title");
    expect(preview.preview.fields.find((f) => f.label === "Priority")?.value).toBe("Medium → High");
  });

  it("refuses an edit that changes nothing, and an edit with no fields", async () => {
    const { ctx } = seed();
    const same = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A", priority: "Medium" });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toMatch(/nothing to change/i);
    const empty = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(empty.ok).toBe(false);
  });

  it("merges into the current row_data, keeps scope columns, and audits once per patch", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(updateWorkOrderTool, ctx, {
      workOrderId: "WO-A",
      priority: "High",
      preferredArrival: "weekday mornings",
    });
    expect(exec.ok).toBe(true);

    const row = tables.portal_work_order_records!.find((r) => r.id === "WO-A")!;
    const data = row.row_data as Record<string, unknown>;
    expect(data.priority).toBe("High");
    expect(data.preferredArrival).toBe("weekday mornings");
    // Untouched fields survive the merge; scope columns are unchanged.
    expect(data.description).toBe("Kitchen sink drips under the cabinet.");
    expect(data.entryPermission).toBe("call_first");
    expect(row.resident_email).toBe(RES_A.email);
    expect(row.manager_user_id).toBe(MANAGER);

    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(String(audit?.values.dedupe_key)).toMatch(/^update_work_order:resident_a:WO-A:/);

    // Confirming the same patch again is a no-op, not a second write.
    const again = await executeWrite(updateWorkOrderTool, ctx, {
      workOrderId: "WO-A",
      priority: "High",
      preferredArrival: "weekday mornings",
    });
    expect(again.ok).toBe(true);
    expect(mutations.filter((m) => m.table === "portal_work_order_records")).toHaveLength(1);
  });
});

describe("cancel_work_order", () => {
  it("warns that the request is removed permanently", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.warnings?.[0]).toMatch(/permanently/i);
    expect(preview.preview.fields.some((f) => f.value.includes("WO-WO-A"))).toBe(true);
  });

  it("deletes only the resident's own row, releases the calendar entry, audits one-shot", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok).toBe(true);
    expect(tables.portal_work_order_records!.some((r) => r.id === "WO-A")).toBe(false);
    expect(tables.portal_work_order_records!.some((r) => r.id === "WO-B")).toBe(true);
    expect(syncCalendar).toHaveBeenCalledTimes(1);
    expect(syncCalendar.mock.calls[0]![2]).toMatchObject({ id: "WO-A", bucket: "completed" });
    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(audit?.values.dedupe_key).toBe("cancel_work_order:resident_a:WO-A");
  });
});

describe("nudge_manager_on_work_order", () => {
  it("refuses while the 24-hour cooldown is running", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A-REMINDED" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/sent recently/i);
    expect(reminderCooldownRemainingMs({ residentReminderSentAt: new Date().toISOString() } as never)).toBeGreaterThan(0);
    expect(reminderCooldownRemainingMs({} as never)).toBe(0);
  });

  it("sends through the shared reminder helper, audits per request per day, tracks the funnel event", async () => {
    const { ctx, mutations } = seed();
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok).toBe(true);
    expect(deliverReminder).toHaveBeenCalledTimes(1);
    expect(deliverReminder.mock.calls[0]![1]).toMatchObject({
      workOrderId: "WO-A",
      residentUserId: RES_A.id,
      residentEmail: RES_A.email,
    });
    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(audit?.values.dedupe_key).toBe(`nudge_manager_on_work_order:resident_a:WO-A:${auditDayBucket()}`);
    expect(track).toHaveBeenCalledWith(
      "resident_work_order_reminder_sent",
      RES_A.id,
      expect.objectContaining({ work_order_id: "WO-A", recipient_count: 2 }),
    );

    // A second confirm the same day is absorbed by the dedupe key.
    const again = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(again.ok).toBe(true);
    expect(deliverReminder).toHaveBeenCalledTimes(1);
  });

  it("surfaces the helper's refusal and releases the dedupe key", async () => {
    deliverReminder.mockResolvedValue({ ok: false, error: "No manager recipients found." });
    const { ctx } = seed();
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok).toBe(false);
    if (!exec.ok) expect(exec.error).toMatch(/No manager recipients/);
    // The key was cleared, so a retry reaches the helper again.
    deliverReminder.mockResolvedValue({ ok: true, recipientCount: 1 });
    const retry = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(retry.ok).toBe(true);
    expect(deliverReminder).toHaveBeenCalledTimes(2);
  });
});
