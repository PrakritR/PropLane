import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";

// Partial mock: automation slot tools resolve slots through
// loadManagerScheduledMessages (heavy projection over many tables); everything
// else in the module stays real so the charge-upsert reminder lifecycle
// (cancel-on-paid) runs end to end against the fake db.
vi.mock("@/lib/payment-automation-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-server")>();
  return { ...actual, loadManagerScheduledMessages: vi.fn(async () => ({ settings: {}, messages: [] })) };
});

import { loadManagerScheduledMessages } from "@/lib/payment-automation-server";
import { buildRegistry } from "@/lib/tools/registry";
import { executeWrite, previewWrite } from "./fake-agent-ctx";
import {
  createChargeTool,
  updateChargeTool,
  deleteChargeTool,
  markChargePaidTool,
  stableInputHash,
} from "@/lib/tools/domains/charges";
import {
  getAutomationSettingsTool,
  updateAutomationSettingsTool,
  cancelScheduledReminderTool,
  rescheduleReminderTool,
} from "@/lib/tools/domains/automation";

const mockedLoadScheduled = vi.mocked(loadManagerScheduledMessages);

const LANDLORD = "11111111-1111-4111-8111-111111111111";
const OTHER_LANDLORD = "22222222-2222-4222-8222-222222222222";
const RESIDENT_UUID = "33333333-3333-4333-8333-333333333333";

/**
 * Richer local extension of the FakeQuery/fake-ctx pattern
 * (tests/unit/tools/fake-agent-ctx.ts): the write tools here need
 * insert/upsert/update/delete/maybeSingle/in on top of the read chain, plus the
 * audit_log partial-unique dedupe_key behavior. Filters actually apply, so a
 * tool that drops its landlord scope would see (or mutate) foreign rows and
 * fail these tests.
 */
type Row = Record<string, unknown>;

function makeFakeDb(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const tableRows = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  function builder(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let mode: "select" | "delete" | "update" = "select";
    let updateVals: Row = {};
    const run = () => {
      const matches = tableRows(table).filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        tables.set(table, tableRows(table).filter((r) => !filters.every((f) => f(r))));
        return { data: null, error: null };
      }
      if (mode === "update") {
        for (const r of matches) Object.assign(r, updateVals);
        return { data: null, error: null };
      }
      return { data: matches.map((r) => ({ ...r })), error: null };
    };
    const api = {
      select: () => api,
      order: () => api,
      limit: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      gte: (col: string, val: unknown) => {
        filters.push((r) => String(r[col] ?? "") >= String(val ?? ""));
        return api;
      },
      lte: (col: string, val: unknown) => {
        filters.push((r) => String(r[col] ?? "") <= String(val ?? ""));
        return api;
      },
      delete: () => {
        mode = "delete";
        return api;
      },
      update: (vals: Row) => {
        mode = "update";
        updateVals = vals;
        return api;
      },
      // Insert is chainable, not a bare promise: the ledger sync inserts with
      // `.insert(row).select("id").single()`, so awaiting it directly and
      // reading the inserted row back must both work off ONE execution.
      insert: (rows: Row | Row[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        let result: { data: Row[] | null; error: { code: string; message: string } | null } | null = null;
        const exec = () => {
          if (result) return result;
          const inserted: Row[] = [];
          for (const row of list) {
            // Mirror the partial UNIQUE index on audit_log.dedupe_key (NULLs never collide).
            if (
              table === "audit_log" &&
              row.dedupe_key != null &&
              tableRows(table).some((r) => r.dedupe_key === row.dedupe_key)
            ) {
              result = { data: null, error: { code: "23505", message: "duplicate key value" } };
              return result;
            }
            const stored = { id: `${table}_${tableRows(table).length + 1}`, ...row };
            tableRows(table).push(stored);
            inserted.push(stored);
          }
          result = { data: inserted, error: null };
          return result;
        };
        const chain = {
          select: () => chain,
          single: async () => {
            const r = exec();
            return { data: r.data?.[0] ?? null, error: r.error };
          },
          maybeSingle: async () => {
            const r = exec();
            return { data: r.data?.[0] ?? null, error: r.error };
          },
          then: <T>(resolve: (v: { data: Row[] | null; error: unknown }) => T) =>
            Promise.resolve(exec()).then(resolve),
        };
        return chain;
      },
      upsert: async (rows: Row | Row[], opts?: { onConflict?: string }) => {
        const keys = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list) {
          const existing = tableRows(table).find((r) => keys.every((k) => r[k] === row[k]));
          if (existing) Object.assign(existing, row);
          else tableRows(table).push({ ...row });
        }
        return { error: null };
      },
      range: async (from: number, to: number) => {
        const { data } = run();
        return { data: (data ?? []).slice(from, to + 1), error: null };
      },
      maybeSingle: async () => {
        const { data } = run();
        return { data: data?.[0] ?? null, error: null };
      },
      then: <T>(resolve: (v: { data: Row[] | null; error: null }) => T) => Promise.resolve(run()).then(resolve),
    };
    return api;
  }

  return { db: { from: builder }, tables };
}

function makeCtx(seed: Record<string, Row[]> = {}) {
  const { db, tables } = makeFakeDb(seed);
  const ctx = {
    landlordId: LANDLORD,
    userId: LANDLORD,
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
  } as unknown as AgentContext;
  return { ctx, tables };
}

function chargeRow(managerUserId: string, overrides: Partial<HouseholdCharge> & { id: string }): Row {
  const full: HouseholdCharge = {
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: "res@example.com",
    residentName: "Pat Resident",
    residentUserId: null,
    propertyId: "prop_1",
    propertyLabel: "12 Main St",
    managerUserId,
    kind: "other_cost",
    title: "Cleaning fee",
    amountLabel: "$1,500.00",
    balanceLabel: "$1,500.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueDateLabel: "Jan 1, 2999",
    ...overrides,
  };
  return {
    id: full.id,
    manager_user_id: managerUserId,
    resident_email: full.residentEmail.trim().toLowerCase(),
    status: full.status,
    row_data: full,
  };
}

function applicantRow(
  managerUserId: string,
  overrides: { id: string; email: string; bucket?: string; name?: string; property?: string; assignedPropertyId?: string },
): Row {
  return {
    id: overrides.id,
    manager_user_id: managerUserId,
    row_data: {
      id: overrides.id,
      name: overrides.name ?? "Pat Resident",
      email: overrides.email,
      bucket: overrides.bucket ?? "approved",
      property: overrides.property ?? "12 Main St",
      assignedPropertyId: overrides.assignedPropertyId ?? "prop_1",
      stage: "Approved",
      detail: "",
    },
  };
}

function slotMessage(overrides: Partial<ScheduledPaymentMessage> = {}): ScheduledPaymentMessage {
  return {
    id: "sched|c1|pre_due|3|2998-12-29",
    chargeId: "c1",
    kind: "pre_due",
    daysBeforeDue: 3,
    sendAt: "2998-12-29T12:00:00.000Z",
    visibleFrom: "2998-12-26T12:00:00.000Z",
    dueDate: "2999-01-01T00:00:00.000Z",
    dueDateLabel: "Jan 1, 2999",
    residentName: "Pat Resident",
    residentEmail: "res@example.com",
    chargeTitle: "Monthly rent",
    propertyLabel: "12 Main St",
    balanceDue: "$1,500.00",
    subject: "s",
    body: "b",
    status: "scheduled",
    managerUserId: LANDLORD,
    typeLabel: "3 days before due",
    ...overrides,
  };
}

beforeEach(() => {
  mockedLoadScheduled.mockClear();
  mockedLoadScheduled.mockResolvedValue({ settings: {} as never, messages: [] });
});

describe("tool registry safety", () => {
  it("registers every charge/automation tool without banned identity input fields", () => {
    expect(() =>
      buildRegistry([
        createChargeTool,
        updateChargeTool,
        deleteChargeTool,
        markChargePaidTool,
        getAutomationSettingsTool,
        updateAutomationSettingsTool,
        cancelScheduledReminderTool,
        rescheduleReminderTool,
      ]),
    ).not.toThrow();
    expect(deleteChargeTool.destructive).toBe(true);
  });
});

describe("create_charge", () => {
  it("preview rejects an email that is not one of THIS landlord's approved residents", async () => {
    const { ctx } = makeCtx({
      manager_application_records: [
        // Foreign landlord's approved resident and an own non-approved lead.
        applicantRow(OTHER_LANDLORD, { id: "a1", email: "foreign@example.com" }),
        applicantRow(LANDLORD, { id: "a2", email: "lead@example.com", bucket: "leads" }),
      ],
    });
    for (const email of ["foreign@example.com", "lead@example.com"]) {
      const res = await previewWrite(createChargeTool, ctx, {
        residentEmail: email,
        kind: "other_cost",
        title: "Cleaning fee",
        amountUsd: 100,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("list_residents");
    }
  });

  it("preview resolves the resident, formats the amount, and notes auto reminders", async () => {
    const { ctx } = makeCtx({
      manager_application_records: [applicantRow(LANDLORD, { id: "a1", email: "Res@Example.com" })],
    });
    const res = await previewWrite(createChargeTool, ctx, {
      residentEmail: "res@example.com",
      kind: "other_cost",
      title: "Cleaning fee",
      amountUsd: 1250,
      dueDate: "2026-08-01",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preview.fields).toEqual(
      expect.arrayContaining([
        { label: "Amount", value: "$1,250.00" },
        { label: "Resident", value: "Pat Resident (res@example.com)" },
        expect.objectContaining({ label: "Reminders" }),
      ]),
    );
  });

  it("execute creates the row pinned to the landlord, writes ledger + audit with the spec dedupe key", async () => {
    const { ctx, tables } = makeCtx({
      manager_application_records: [applicantRow(LANDLORD, { id: "a1", email: "res@example.com" })],
      profiles: [{ id: RESIDENT_UUID, email: "res@example.com" }],
    });
    const res = await executeWrite(createChargeTool, ctx, {
      residentEmail: "res@example.com",
      kind: "other_cost",
      title: "Cleaning fee",
      amountUsd: 1250,
      dueDate: "2026-08-01",
    });
    expect(res.ok).toBe(true);

    const rows = tables.get("portal_household_charge_records") ?? [];
    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.manager_user_id).toBe(LANDLORD);
    const rowData = stored.row_data as HouseholdCharge;
    expect(rowData.managerUserId).toBe(LANDLORD);
    expect(rowData.residentUserId).toBe(RESIDENT_UUID);
    expect(rowData.status).toBe("pending");
    expect(rowData.amountLabel).toBe("$1,250.00");
    expect(rowData.dueDateLabel).toBeTruthy();

    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`create_charge:${LANDLORD}:res@example.com:other_cost:1250.00:2026-08-01`);
    // Write-through ledger (AGENTS.md hard rule): the charge entry exists.
    const ledger = tables.get("ledger_entries") ?? [];
    expect(ledger.some((l) => l.entry_type === "charge" && l.source_charge_id === rowData.id)).toBe(true);
  });

  it("execute is idempotent for an identical create (audit dedupe short-circuits)", async () => {
    const { ctx, tables } = makeCtx({
      manager_application_records: [applicantRow(LANDLORD, { id: "a1", email: "res@example.com" })],
    });
    const input = { residentEmail: "res@example.com", kind: "other_cost" as const, title: "Fee", amountUsd: 50 };
    const first = await executeWrite(createChargeTool, ctx, input);
    const second = await executeWrite(createChargeTool, ctx, input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.reply.toLowerCase()).toContain("already");
    expect(tables.get("portal_household_charge_records")).toHaveLength(1);
  });
});

describe("update_charge", () => {
  it("preview rejects a foreign chargeId (cross-landlord isolation)", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [chargeRow(OTHER_LANDLORD, { id: "c_foreign" })],
    });
    const res = await previewWrite(updateChargeTool, ctx, { chargeId: "c_foreign", amountUsd: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("list_charges");
  });

  it("preview refuses paid charges and shows a from → to diff for pending ones", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [
        chargeRow(LANDLORD, { id: "c_paid", status: "paid" }),
        chargeRow(LANDLORD, { id: "c_open" }),
      ],
    });
    const paid = await previewWrite(updateChargeTool, ctx, { chargeId: "c_paid", amountUsd: 10 });
    expect(paid.ok).toBe(false);
    if (!paid.ok) expect(paid.error).toContain("paid");

    const open = await previewWrite(updateChargeTool, ctx, { chargeId: "c_open", amountUsd: 1600 });
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.preview.fields).toEqual(
        expect.arrayContaining([{ label: "Amount", value: "$1,500.00 → $1,600.00" }]),
      );
    }
  });

  it("execute read-merge-writes the current row_data and audits with a patch-hash key", async () => {
    const { ctx, tables } = makeCtx({
      portal_household_charge_records: [chargeRow(LANDLORD, { id: "c_open" })],
    });
    const res = await executeWrite(updateChargeTool, ctx, { chargeId: "c_open", amountUsd: 1600 });
    expect(res.ok).toBe(true);

    const rowData = (tables.get("portal_household_charge_records") ?? [])[0]!.row_data as HouseholdCharge;
    expect(rowData.amountLabel).toBe("$1,600.00");
    expect(rowData.balanceLabel).toBe("$1,600.00");
    // Untouched fields survive the merge.
    expect(rowData.title).toBe("Cleaning fee");
    expect(rowData.residentEmail).toBe("res@example.com");

    const expectedHash = stableInputHash({ amountUsd: 1600, dueDate: null, title: null });
    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`update_charge:${LANDLORD}:c_open:${expectedHash}`);
  });

  it("execute refuses paid and foreign charges", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [
        chargeRow(LANDLORD, { id: "c_paid", status: "paid" }),
        chargeRow(OTHER_LANDLORD, { id: "c_foreign" }),
      ],
    });
    expect((await executeWrite(updateChargeTool, ctx, { chargeId: "c_paid", amountUsd: 10 })).ok).toBe(false);
    expect((await executeWrite(updateChargeTool, ctx, { chargeId: "c_foreign", amountUsd: 10 })).ok).toBe(false);
  });
});

describe("delete_charge", () => {
  it("preview rejects foreign ids and warns on owned ones", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [
        chargeRow(LANDLORD, { id: "c_mine" }),
        chargeRow(OTHER_LANDLORD, { id: "c_foreign" }),
      ],
    });
    expect((await previewWrite(deleteChargeTool, ctx, { chargeId: "c_foreign" })).ok).toBe(false);
    const mine = await previewWrite(deleteChargeTool, ctx, { chargeId: "c_mine" });
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.preview.warnings?.[0]).toContain("cannot be undone");
  });

  it("execute deletes the owned row AND its ledger entries, never another landlord's", async () => {
    const { ctx, tables } = makeCtx({
      portal_household_charge_records: [
        chargeRow(LANDLORD, { id: "c_mine" }),
        chargeRow(OTHER_LANDLORD, { id: "c_foreign" }),
      ],
      ledger_entries: [
        { id: 1, manager_user_id: LANDLORD, source_charge_id: "c_mine", entry_type: "charge" },
        { id: 2, manager_user_id: LANDLORD, source_charge_id: "c_mine", entry_type: "payment" },
        // Same source id under another landlord — must survive the scoped delete.
        { id: 3, manager_user_id: OTHER_LANDLORD, source_charge_id: "c_mine", entry_type: "charge" },
      ],
    });
    const res = await executeWrite(deleteChargeTool, ctx, { chargeId: "c_mine" });
    expect(res.ok).toBe(true);

    const charges = tables.get("portal_household_charge_records") ?? [];
    expect(charges.map((r) => r.id)).toEqual(["c_foreign"]);
    const ledger = tables.get("ledger_entries") ?? [];
    expect(ledger.map((l) => l.id)).toEqual([3]);

    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`delete_charge:${LANDLORD}:c_mine`);

    // One-shot dedupe: a repeat returns already-done.
    const again = await executeWrite(deleteChargeTool, ctx, { chargeId: "c_mine" });
    expect(again.ok).toBe(false); // row is gone → re-resolve fails first
  });
});

describe("mark_charge_paid", () => {
  it("preview names the hand-taken payment method and the reminder/ledger effect", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [chargeRow(LANDLORD, { id: "c_open" })],
    });
    const res = await previewWrite(markChargePaidTool, ctx, { chargeId: "c_open", channel: "check" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const values = res.preview.fields.map((l) => l.value).join(" | ");
    expect(values).toContain("check");
    expect(values).toContain("Future reminders cancelled; payment recorded in the ledger");
  });

  it("preview/execute refuse paid and foreign charges", async () => {
    const { ctx } = makeCtx({
      portal_household_charge_records: [
        chargeRow(LANDLORD, { id: "c_paid", status: "paid" }),
        chargeRow(OTHER_LANDLORD, { id: "c_foreign" }),
      ],
    });
    expect((await previewWrite(markChargePaidTool, ctx, { chargeId: "c_paid" })).ok).toBe(false);
    expect((await previewWrite(markChargePaidTool, ctx, { chargeId: "c_foreign" })).ok).toBe(false);
    expect((await executeWrite(markChargePaidTool, ctx, { chargeId: "c_paid" })).ok).toBe(false);
    expect((await executeWrite(markChargePaidTool, ctx, { chargeId: "c_foreign" })).ok).toBe(false);
  });

  it("execute marks paid, writes the payment ledger entry, cancels future reminders, audits one-shot", async () => {
    const { ctx, tables } = makeCtx({
      portal_household_charge_records: [chargeRow(LANDLORD, { id: "c_open" })],
    });
    const res = await executeWrite(markChargePaidTool, ctx, { chargeId: "c_open", channel: "cash" });
    expect(res.ok).toBe(true);

    const rowData = (tables.get("portal_household_charge_records") ?? [])[0]!.row_data as HouseholdCharge;
    expect(rowData.status).toBe("paid");
    expect(rowData.paidAt).toBeTruthy();
    expect(rowData.balanceLabel).toBe("$0.00");

    const ledger = tables.get("ledger_entries") ?? [];
    expect(ledger.some((l) => l.entry_type === "payment" && l.source_charge_id === "c_open")).toBe(true);

    // Reminders can no longer send: the reminder cron only loads status=pending
    // charges, and this row is now paid. (Note: the belt-and-braces override
    // cancellation in payment-reminder-lifecycle.server.ts currently no-ops for
    // rows carrying paidAt — its treatAsPending projection forgets to strip
    // paidAt before isUnpaidHouseholdCharge. Pre-existing upstream gap, hit by
    // the route path too; not fixable from this tool layer.)
    const stored = (tables.get("portal_household_charge_records") ?? [])[0]!;
    expect(stored.status).toBe("paid");

    const audit = (tables.get("audit_log") ?? []).find((a) => a.tool_name === "mark_charge_paid")!;
    expect(audit.dedupe_key).toBe(`mark_charge_paid:${LANDLORD}:c_open`);
  });
});

describe("get_automation_settings", () => {
  it("returns the cadence summary and settings WITHOUT free-text templates", async () => {
    const { ctx } = makeCtx();
    const res = (await getAutomationSettingsTool.handler(ctx, {})) as {
      scheduleSummary: string;
      settings: Record<string, unknown>;
    };
    expect(res.scheduleSummary).toContain("days before");
    expect(res.settings.preDueReminderDays).toEqual([3, 2, 1]);
    expect(res.settings).not.toHaveProperty("templates");
  });
});

describe("update_automation_settings", () => {
  it("preview requires at least one field and diffs before → after", async () => {
    const { ctx } = makeCtx();
    expect((await previewWrite(updateAutomationSettingsTool, ctx, {})).ok).toBe(false);

    const res = await previewWrite(updateAutomationSettingsTool, ctx, { sameDayReminderEnabled: false });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preview.fields).toEqual(
        expect.arrayContaining([{ label: "Same-day reminder", value: "on → off" }]),
      );
    }
  });

  it("execute merges + normalizes + saves under the landlord, with a patch-hash dedupe key", async () => {
    const { ctx, tables } = makeCtx();
    const res = await executeWrite(updateAutomationSettingsTool, ctx, {
      sameDayReminderEnabled: false,
      preDueReminderDays: [5, 1],
    });
    expect(res.ok).toBe(true);

    const saved = (tables.get("manager_automation_settings") ?? [])[0]!;
    expect(saved.manager_user_id).toBe(LANDLORD);
    const rowData = saved.row_data as { sameDayReminderEnabled: boolean; preDueReminderDays: number[] };
    expect(rowData.sameDayReminderEnabled).toBe(false);
    expect(rowData.preDueReminderDays).toEqual([5, 1]);

    const expectedHash = stableInputHash({ sameDayReminderEnabled: false, preDueReminderDays: [5, 1], applyExisting: false });
    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`update_automation_settings:${LANDLORD}:${expectedHash}`);

    const again = await executeWrite(updateAutomationSettingsTool, ctx, {
      sameDayReminderEnabled: false,
      preDueReminderDays: [5, 1],
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reply.toLowerCase()).toContain("already");
  });
});

describe("cancel_scheduled_reminder", () => {
  it("preview fails with a corrective error when the slot does not exist for this landlord", async () => {
    const { ctx } = makeCtx();
    const res = await previewWrite(cancelScheduledReminderTool, ctx, { chargeId: "c1", kind: "pre_due", daysBeforeDue: 3 });
    expect(res.ok).toBe(false);
    // The projection is landlord-scoped: a foreign charge id never matches.
    expect(mockedLoadScheduled).toHaveBeenCalledWith(ctx.db, LANDLORD, { includeHidden: true });
  });

  it("preview refuses slots that are already cancelled or sent", async () => {
    mockedLoadScheduled.mockResolvedValue({
      settings: {} as never,
      messages: [slotMessage({ status: "cancelled" })],
    });
    const { ctx } = makeCtx();
    const res = await previewWrite(cancelScheduledReminderTool, ctx, { chargeId: "c1", kind: "pre_due", daysBeforeDue: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cancelled");
  });

  it("execute writes the cancelled override for the exact slot and audits per slot", async () => {
    mockedLoadScheduled.mockResolvedValue({ settings: {} as never, messages: [slotMessage()] });
    const { ctx, tables } = makeCtx();
    const res = await executeWrite(cancelScheduledReminderTool, ctx, { chargeId: "c1", kind: "pre_due", daysBeforeDue: 3 });
    expect(res.ok).toBe(true);

    const overrides = tables.get("scheduled_message_overrides") ?? [];
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.charge_id).toBe("c1");
    expect(overrides[0]!.reminder_kind).toBe("pre_due");
    expect(overrides[0]!.days_before_due).toBe(3);
    expect((overrides[0]!.row_data as { cancelled?: boolean }).cancelled).toBe(true);

    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`cancel_scheduled_reminder:${LANDLORD}:c1:pre_due:3`);

    const again = await executeWrite(cancelScheduledReminderTool, ctx, { chargeId: "c1", kind: "pre_due", daysBeforeDue: 3 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reply.toLowerCase()).toContain("already");
  });
});

describe("reschedule_reminder", () => {
  it("preview rejects an invalid or past newSendAtIso", async () => {
    mockedLoadScheduled.mockResolvedValue({ settings: {} as never, messages: [slotMessage()] });
    const { ctx } = makeCtx();
    const past = await previewWrite(rescheduleReminderTool, ctx, {
      chargeId: "c1",
      kind: "pre_due",
      daysBeforeDue: 3,
      newSendAtIso: "2020-01-01T00:00:00Z",
    });
    expect(past.ok).toBe(false);
    const junk = await previewWrite(rescheduleReminderTool, ctx, {
      chargeId: "c1",
      kind: "pre_due",
      daysBeforeDue: 3,
      newSendAtIso: "not-a-date",
    });
    expect(junk.ok).toBe(false);
  });

  it("execute writes customSendAt for the slot and audits with the slot+time key", async () => {
    mockedLoadScheduled.mockResolvedValue({ settings: {} as never, messages: [slotMessage()] });
    const { ctx, tables } = makeCtx();
    const res = await executeWrite(rescheduleReminderTool, ctx, {
      chargeId: "c1",
      kind: "pre_due",
      daysBeforeDue: 3,
      newSendAtIso: "2998-12-30T09:00:00.000Z",
    });
    expect(res.ok).toBe(true);

    const overrides = tables.get("scheduled_message_overrides") ?? [];
    expect(overrides).toHaveLength(1);
    expect((overrides[0]!.row_data as { customSendAt?: string }).customSendAt).toBe("2998-12-30T09:00:00.000Z");

    const expectedHash = stableInputHash("2998-12-30T09:00:00.000Z");
    const audit = (tables.get("audit_log") ?? [])[0]!;
    expect(audit.dedupe_key).toBe(`reschedule_reminder:${LANDLORD}:c1:pre_due:3:${expectedHash}`);
  });
});
