import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditDayBucket } from "@/lib/tools/audit";
import { runConfirmedPendingActionForPortal } from "@/lib/tools/confirm-gate.server";
import { contentHash } from "@/lib/tools/domains/resident/load-resident-rows";
import {
  cancelWorkOrderTool,
  nudgeManagerOnWorkOrderTool,
  updateWorkOrderTool,
} from "@/lib/tools/domains/resident/work-order-lifecycle";
import { buildRegistry } from "@/lib/tools/registry";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { executeWrite, previewWrite } from "./fake-agent-ctx";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";

/**
 * PRP-268 — the resident's own work-order lifecycle from chat: edit, cancel,
 * nudge. `portal_work_order_records` carries ONLY `resident_email`, so every
 * test seeds a foreign resident's row alongside the caller's and asserts it is
 * never previewable, never executable, and never touched.
 */

const calendarSync = vi.fn(async (_db: unknown, _managerId: string, row: unknown) => row);
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: (db: unknown, managerId: string, row: unknown) => calendarSync(db, managerId, row),
}));

const deliverReminder = vi.fn();
vi.mock("@/lib/resident-work-order-reminder.server", () => ({
  deliverResidentWorkOrderReminder: (...args: unknown[]) => deliverReminder(...args),
}));

const RES_A = { id: "resident_a", email: "resa@axis.test" };
const RES_B = { id: "resident_b", email: "resb@axis.test" };
const MANAGER = "manager_1";

function workOrder(owner: { id: string; email: string }, id: string, extra: Record<string, unknown> = {}): FakeRow {
  return {
    id,
    manager_user_id: MANAGER,
    resident_email: owner.email,
    property_id: "prop_1",
    assigned_property_id: "prop_1",
    row_data: {
      id,
      reference: `WO-${id}`,
      title: `Leaky faucet ${id}`,
      priority: "Medium",
      status: "Open",
      bucket: "open",
      description: "Drips all night",
      preferredArrival: "Anytime",
      entryPermission: "call_first",
      entryNotes: "Gate code 1234",
      propertyName: "Maple House",
      unit: "2B",
      residentEmail: owner.email,
      residentName: owner.id,
      managerUserId: MANAGER,
      propertyId: "prop_1",
      // Server-owned dispatch block — must survive a resident edit untouched.
      dispatch: { state: "proposed", vendorId: "vendor_9" },
      ...extra,
    },
  };
}

function seed(extraRows: FakeRow[] = []) {
  return makeResidentToolCtx({
    portal_work_order_records: [
      workOrder(RES_A, "WO-A"),
      workOrder(RES_A, "WO-A-DONE", { bucket: "completed", status: "Completed" }),
      workOrder(RES_A, "WO-A-SCHED", { bucket: "scheduled", status: "Scheduled" }),
      workOrder(RES_B, "WO-B"),
      ...extraRows,
    ],
    profiles: [{ id: MANAGER, email: "mgr@axis.test", full_name: "Mgr One" }],
    audit_log: [],
  });
}

function rowData(tables: Record<string, FakeRow[]>, id: string) {
  const row = tables.portal_work_order_records!.find((r) => r.id === id);
  return row ? (row.row_data as Record<string, unknown>) : null;
}

beforeEach(() => {
  calendarSync.mockClear();
  deliverReminder.mockReset();
  deliverReminder.mockResolvedValue({ ok: true, recipientCount: 1 });
});

describe("registration", () => {
  it("all three live in the resident registry, and only cancel is destructive", () => {
    for (const name of ["update_work_order", "cancel_work_order", "nudge_manager_on_work_order"]) {
      expect(residentAgentRegistry.get(name)?.kind, name).toBe("write");
    }
    expect(cancelWorkOrderTool.destructive).toBe(true);
    expect(updateWorkOrderTool.destructive).toBeFalsy();
    expect(nudgeManagerOnWorkOrderTool.destructive).toBeFalsy();
  });
});

describe("update_work_order", () => {
  it("previews exactly the fields that will change, on the resident's own row", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(updateWorkOrderTool, ctx, {
      workOrderId: "WO-A",
      title: "Faucet now spraying",
      preferredArrival: "weekday mornings",
      entryPermission: "allowed",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const labels = preview.preview.fields.map((f) => f.label);
    expect(labels).toEqual(["Request", "Property", "Title", "Preferred visit window", "Entry if you're not home"]);
    expect(preview.preview.fields.find((f) => f.label === "Request")?.value).toBe("Leaky faucet WO-A (WO-WO-A)");
    // A preset typed in lower case is stored as the panel's preset, not custom text.
    expect(preview.preview.fields.find((f) => f.label === "Preferred visit window")?.value).toBe("Weekday mornings");
    expect(preview.preview.fields.find((f) => f.label === "Entry if you're not home")?.value).toBe("Yes, they can enter");
    expect(preview.preview.confirmLabel).toBe("Save changes");
  });

  it("refuses another resident's request in preview and execute, touching nothing", async () => {
    const { ctx, mutations } = seed();
    const input = { workOrderId: "WO-B", title: "Hijacked" };
    const preview = await previewWrite(updateWorkOrderTool, ctx, input);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/not one of your/i);
    const exec = await executeWrite(updateWorkOrderTool, ctx, input);
    expect(exec.ok).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("refuses a completed or scheduled request", async () => {
    const { ctx, mutations } = seed();
    const done = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A-DONE", title: "x" });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error).toMatch(/already completed/i);
    const sched = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A-SCHED", title: "x" });
    expect(sched.ok).toBe(false);
    if (!sched.ok) expect(sched.error).toMatch(/already been scheduled/i);
    const exec = await executeWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A-DONE", title: "x" });
    expect(exec.ok).toBe(false);
    expect(mutations).toEqual([]);
  });

  it("refuses an edit that changes nothing", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/nothing to change/i);
  });

  it("rejects fields the panel's edit form does not offer", async () => {
    const { ctx } = seed();
    for (const extra of [{ category: "plumbing" }, { status: "Completed" }, { vendorId: "v1" }, { scheduled: "Mon" }]) {
      const preview = await previewWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A", ...extra });
      expect(preview.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("merges the patch into the live row, pins scope columns, preserves dispatch, and audits", async () => {
    const { ctx, mutations, tables } = seed();
    const patch = {
      title: "Faucet now spraying",
      description: "Water everywhere",
      priority: "High" as const,
      preferredArrival: "Only after 6pm",
      entryPermission: "resident_present" as const,
      entryNotes: "",
    };
    const exec = await executeWrite(updateWorkOrderTool, ctx, { workOrderId: "WO-A", ...patch });
    expect(exec.ok, exec.error).toBe(true);

    const upsert = mutations.find((m) => m.table === "portal_work_order_records" && m.kind === "upsert");
    expect(upsert).toBeTruthy();
    expect(upsert!.values.manager_user_id).toBe(MANAGER);
    expect(upsert!.values.resident_email).toBe(RES_A.email);
    expect(upsert!.values.property_id).toBe("prop_1");

    const next = rowData(tables, "WO-A")!;
    expect(next.title).toBe("Faucet now spraying");
    expect(next.description).toBe("Water everywhere");
    expect(next.priority).toBe("High");
    expect(next.preferredArrival).toBe("Only after 6pm");
    expect(next.entryPermission).toBe("resident_present");
    // Blank entry notes clear them, exactly like the form's `trim() || undefined`.
    expect("entryNotes" in next).toBe(false);
    // Nothing the resident cannot edit moved.
    expect(next.dispatch).toEqual({ state: "proposed", vendorId: "vendor_9" });
    expect(next.bucket).toBe("open");
    expect(next.residentEmail).toBe(RES_A.email);

    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(audit?.values.tool_name).toBe("update_work_order");
    expect(audit?.values.landlord_id).toBe(RES_A.id);
    expect(audit?.values.dedupe_key).toBe(
      `update_work_order:${RES_A.id}:WO-A:${contentHash(JSON.stringify(patch))}:${auditDayBucket()}`,
    );
    expect(JSON.stringify(audit?.values.input_summary)).not.toContain("Water everywhere");
  });

  it("a replayed confirm of the same patch is reported as already saved, with no second write", async () => {
    const { ctx, mutations } = seed();
    const input = { workOrderId: "WO-A", title: "Once" };
    expect((await executeWrite(updateWorkOrderTool, ctx, input)).ok).toBe(true);
    const again = await executeWrite(updateWorkOrderTool, ctx, input);
    expect(again.ok).toBe(true);
    expect(again.reply).toMatch(/already saved/i);
    expect(mutations.filter((m) => m.table === "portal_work_order_records")).toHaveLength(1);
  });
});

describe("cancel_work_order", () => {
  it("names the request and warns the cancel cannot be undone", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.destructive).toBe(true);
    expect(preview.preview.fields.find((f) => f.label === "Request")?.value).toContain("Leaky faucet WO-A");
    expect(preview.preview.fields.find((f) => f.label === "Property")?.value).toBe("Maple House · 2B");
    expect(preview.preview.warnings?.some((w) => /cannot be undone/i.test(w))).toBe(true);
  });

  it("refuses another resident's request and a closed one, touching nothing", async () => {
    const { ctx, mutations, tables } = seed();
    expect((await previewWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-B" })).ok).toBe(false);
    expect((await executeWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-B" })).ok).toBe(false);
    expect((await previewWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A-DONE" })).ok).toBe(false);
    expect((await executeWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A-DONE" })).ok).toBe(false);
    expect(mutations).toEqual([]);
    expect(tables.portal_work_order_records).toHaveLength(4);
  });

  it("removes the row the way the panel's Cancel service does, releases the calendar hold, and audits once", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(cancelWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok, exec.error).toBe(true);
    expect(exec.reply).toMatch(/cancelled/i);

    expect(rowData(tables, "WO-A")).toBeNull();
    expect(rowData(tables, "WO-B")).not.toBeNull();
    expect(mutations.filter((m) => m.table === "portal_work_order_records" && m.kind === "delete")).toHaveLength(1);
    expect(calendarSync).toHaveBeenCalledTimes(1);
    expect(calendarSync.mock.calls[0]![1]).toBe(MANAGER);
    expect((calendarSync.mock.calls[0]![2] as { bucket: string }).bucket).toBe("completed");

    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(audit?.values.tool_name).toBe("cancel_work_order");
    expect(audit?.values.dedupe_key).toBe(`cancel_work_order:${RES_A.id}:WO-A`);
    expect(audit?.values.input_summary).toEqual({ workOrderId: "WO-A" });
  });
});

describe("nudge_manager_on_work_order", () => {
  it("shows who is nudged and that no reminder has been sent yet", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.fields.find((f) => f.label === "Reminding")?.value).toBe("Mgr One (mgr@axis.test)");
    expect(preview.preview.fields.find((f) => f.label === "Last reminder")?.value).toBe("Never");
  });

  it("refuses a second nudge inside the 24-hour cooldown, naming the last nudge time", async () => {
    const sentAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { ctx, mutations } = seed([workOrder(RES_A, "WO-A-NUDGED", { residentReminderSentAt: sentAt })]);
    const preview = await previewWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A-NUDGED" });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toMatch(/another reminder in about 22 hours/i);
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A-NUDGED" });
    expect(exec.ok).toBe(false);
    expect(deliverReminder).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it("allows a nudge once the cooldown has elapsed, showing the previous one", async () => {
    const sentAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { ctx } = seed([workOrder(RES_A, "WO-A-OLD", { residentReminderSentAt: sentAt })]);
    const preview = await previewWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A-OLD" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.fields.find((f) => f.label === "Last reminder")?.value).not.toBe("Never");
  });

  it("refuses another resident's request and never reaches the delivery path", async () => {
    const { ctx, mutations } = seed();
    expect((await previewWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-B" })).ok).toBe(false);
    expect((await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-B" })).ok).toBe(false);
    expect(deliverReminder).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it("delivers through the same reminder path as the panel, with the resident's own identity", async () => {
    const { ctx, mutations } = seed();
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok, exec.error).toBe(true);
    expect(deliverReminder).toHaveBeenCalledTimes(1);
    expect(deliverReminder.mock.calls[0]![1]).toEqual({
      workOrderId: "WO-A",
      residentUserId: RES_A.id,
      residentEmail: RES_A.email,
      residentName: RES_A.id,
    });
    const audit = mutations.find((m) => m.table === "audit_log" && m.kind === "insert");
    expect(audit?.values.dedupe_key).toBe(`nudge_manager_on_work_order:${RES_A.id}:WO-A:${auditDayBucket()}`);
    const stamped = mutations.find((m) => m.table === "audit_log" && m.kind === "update");
    expect(stamped?.values.result_summary).toEqual({ workOrderId: "WO-A", recipientCount: 1 });
  });

  it("surfaces the delivery refusal and clears the dedupe key so a retry can record afresh", async () => {
    deliverReminder.mockResolvedValue({ ok: false, error: "No manager recipients found." });
    const { ctx, mutations } = seed();
    const exec = await executeWrite(nudgeManagerOnWorkOrderTool, ctx, { workOrderId: "WO-A" });
    expect(exec.ok).toBe(false);
    expect(exec.error).toBe("No manager recipients found.");
    const stamped = mutations.find((m) => m.table === "audit_log" && m.kind === "update");
    expect(stamped?.values.dedupe_key).toBeNull();
  });
});

/**
 * The confirm gate binds a proposal to the portal it was made in. A dual-role
 * account's resident proposal to cancel a request must not be executable from
 * the manager portal — the row is not even claimed.
 */
describe("confirm gate: a manager-portal claim of a resident cancel is refused", () => {
  type Row = Record<string, unknown> & { id: string };

  function pendingActionsChain(rows: Row[]) {
    const matches = (row: Row, filters: [string, string, unknown][]) =>
      filters.every(([op, col, val]) => (op === "eq" ? row[col] === val : String(row[col] ?? "") > String(val ?? "")));
    const filters: [string, string, unknown][] = [];
    let update: Row | null = null;
    const apply = () => {
      const hits = rows.filter((r) => matches(r, filters));
      for (const r of hits) Object.assign(r, update ?? {});
      return hits.map((r) => ({ ...r }));
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (values: Row) => {
        update = values;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        filters.push(["eq", col, val]);
        return chain;
      },
      gt: (col: string, val: unknown) => {
        filters.push(["gt", col, val]);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: any) => unknown) => Promise.resolve({ data: apply(), error: null }).then(resolve),
    };
    return chain;
  }

  function gateSetup() {
    const base = seed();
    const pending: Row[] = [
      {
        id: "act_1",
        user_id: RES_A.id,
        portal: "resident",
        tool_name: "cancel_work_order",
        input: { workOrderId: "WO-A" },
        status: "proposed",
        session_id: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const residentDb = base.ctx.db as { from(table: string): unknown };
    const db = {
      from(table: string) {
        return table === "agent_pending_actions" ? pendingActionsChain(pending) : residentDb.from(table);
      },
    };
    const ctx = { ...base.ctx, db } as unknown as ResidentAgentContext;
    return { ctx, pending, tables: base.tables, mutations: base.mutations };
  }

  const registry = buildRegistry<ResidentAgentContext>([cancelWorkOrderTool]);

  it("refuses from the manager portal, leaving the proposal and the request intact", async () => {
    const { ctx, pending, tables, mutations } = gateSetup();
    const result = await runConfirmedPendingActionForPortal(ctx, registry, "manager", "act_1");
    expect(result.ok).toBe(false);
    expect(pending[0]!.status).toBe("proposed");
    expect(rowData(tables, "WO-A")).not.toBeNull();
    expect(mutations.filter((m) => m.table === "portal_work_order_records")).toEqual([]);
  });

  it("executes the same proposal from the resident portal", async () => {
    const { ctx, pending, tables } = gateSetup();
    const result = await runConfirmedPendingActionForPortal(ctx, registry, "resident", "act_1");
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(pending[0]!.status).toBe("executed");
    expect(rowData(tables, "WO-A")).toBeNull();
  });
});
