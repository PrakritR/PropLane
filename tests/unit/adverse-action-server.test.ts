import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";

const h = vi.hoisted(() => ({
  emit: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
  coManager: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: h.emit }));
vi.mock("@/lib/domain-action-events.server", () => ({
  managerSender: async (_db: unknown, id: string) => ({ userId: id, email: "mgr@example.com", name: "Mgr" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: h.admin }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCoManagerPermissionForProperty: h.coManager }));
vi.mock("@/lib/tools/audit", () => ({ writeAuditLog: h.audit }));

import {
  adverseActionDeclineBlocker,
  cancelAdverseAction,
  decideAdverseAction,
  finalizeAdverseAction,
} from "@/lib/screening/adverse-action.server";

type Rec = Record<string, unknown>;

/** A tiny in-memory Supabase: just the two tables adverse action touches. */
function memoryDb(applicationRow: Partial<DemoApplicantRow> | null) {
  const adverse: Rec[] = [];
  let seq = 0;
  const db = {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let mode: "select" | "insert" | "update" = "select";
      let pending: Rec | null = null;
      let ordered = false;
      let limit = Infinity;
      const chain: Record<string, unknown> = {};
      const rowsNow = () => {
        let rows = adverse.filter((r) => filters.every(([k, v]) => r[k] === v));
        if (ordered) rows = [...rows].reverse();
        return rows.slice(0, limit);
      };
      chain.select = () => chain;
      chain.eq = (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      };
      chain.order = () => {
        ordered = true;
        return chain;
      };
      chain.limit = (n: number) => {
        limit = n;
        return chain;
      };
      chain.insert = (payload: Rec) => {
        mode = "insert";
        pending = { id: `aa-${++seq}`, pre_adverse_sent_at: null, final_due_at: null, final_sent_at: null, ...payload };
        adverse.push(pending);
        return chain;
      };
      chain.update = (payload: Rec) => {
        mode = "update";
        pending = payload;
        return chain;
      };
      const finish = () => {
        if (table === "manager_application_records") {
          return {
            data: applicationRow
              ? { id: "app-1", manager_user_id: "mgr-1", property_id: "prop-1", assigned_property_id: null, row_data: applicationRow }
              : null,
            error: null,
          };
        }
        if (mode === "update") {
          for (const r of rowsNow()) Object.assign(r, pending);
          return { data: null, error: null };
        }
        if (mode === "insert") return { data: pending, error: null };
        return { data: rowsNow(), error: null };
      };
      chain.single = async () => finish();
      chain.maybeSingle = async () => finish();
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(finish()).then(resolve);
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, adverse };
}

const completeCheck = { provider: "checkr", candidateId: "ap_1", reportId: "ord_1", packageSlug: "starter", status: "complete", result: "consider", orderedAt: "2026-11-12T00:00:00Z" } as const;
const appRow = (over: Partial<DemoApplicantRow> = {}): Partial<DemoApplicantRow> => ({
  id: "app-1",
  name: "Jane Doe",
  email: "jane@example.com",
  property: "12 Pine St",
  bucket: "pending",
  managerUserId: "mgr-1",
  residentUserId: "res-1",
  backgroundCheck: completeCheck as unknown as DemoApplicantRow["backgroundCheck"],
  ...over,
});
const manager = { id: "mgr-1" };
const origin = "https://proplane.ai";

beforeEach(() => {
  h.emit.mockReset().mockResolvedValue({ eventId: "e", duplicate: false, delivered: 2, submitted: 0, deferred: 0, failed: 0 });
  h.audit.mockReset().mockResolvedValue({ recorded: true });
  h.admin.mockReset().mockResolvedValue(false);
  h.coManager.mockReset().mockResolvedValue(false);
});

describe("a decline NOT based on the report", () => {
  it("records the answer, sends no adverse notice, and allows the normal decline", async () => {
    const { db, adverse } = memoryDb(appRow());
    const result = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: false, origin });
    expect(result).toMatchObject({ ok: true, status: { required: true, stage: "not_based", declineAllowed: true } });
    expect(h.emit).not.toHaveBeenCalled();
    expect(adverse).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "adverse_action_not_based" }));
    expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow() as DemoApplicantRow }, { bucket: "rejected" })).toBe("no");
  });
});

describe("an application with no completed consumer report", () => {
  it("asks nothing and writes nothing: the normal decline applies", async () => {
    for (const backgroundCheck of [undefined, { ...completeCheck, status: "pending", result: null }]) {
      const { db, adverse } = memoryDb(appRow({ backgroundCheck: backgroundCheck as never }));
      const result = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
      expect(result).toMatchObject({ ok: true, status: { required: false, declineAllowed: true } });
      expect(adverse).toHaveLength(0);
      expect(h.emit).not.toHaveBeenCalled();
      expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow({ backgroundCheck: backgroundCheck as never }) as DemoApplicantRow }, { bucket: "rejected" })).toBe("no");
    }
  });
});

describe("pre-adverse, five business days, then the final notice", () => {
  it("YES sends the pre-adverse notice (report link, rights, agency), stores the due date and keeps the application pending", async () => {
    const { db, adverse } = memoryDb(appRow());
    const result = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    expect(result).toMatchObject({ ok: true, status: { required: true, stage: "pre_adverse_sent", declineAllowed: false, canFinalize: false } });
    expect(h.emit).toHaveBeenCalledTimes(1);
    const event = h.emit.mock.calls[0]![1];
    expect(event).toMatchObject({ domain: "application", event: "application_pre_adverse_action", systemNotice: true, entityId: "app-1" });
    const resident = event.recipients.find((r: { audience: string }) => r.audience === "resident");
    expect(resident).toMatchObject({ userId: "res-1", email: "jane@example.com" });
    expect(resident.rendered.text).toContain("https://proplane.ai/api/screening/adverse-action/report?applicationId=app-1");
    expect(resident.rendered.text).toMatch(/Summary of Your Rights Under the Fair Credit Reporting Act/);
    expect(adverse[0]).toMatchObject({ stage: "pre_adverse_sent", based_on_report: true, report_id: "ord_1" });
    const sent = Date.parse(String(adverse[0]!.pre_adverse_sent_at));
    const due = Date.parse(String(adverse[0]!.final_due_at));
    // at least 5 calendar days (5 business days is never fewer) and at most 9 (weekends + a holiday)
    expect((due - sent) / 86_400_000).toBeGreaterThanOrEqual(5);
    expect((due - sent) / 86_400_000).toBeLessThanOrEqual(9);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "adverse_action_pre_adverse_sent" }));
    // The write backstop: declining is refused until the final notice.
    expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow() as DemoApplicantRow }, { bucket: "rejected" })).toBe("blocked");
  });

  it("a second Yes while one is waiting is refused, never a second notice", async () => {
    const { db } = memoryDb(appRow());
    await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    const again = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    expect(again).toMatchObject({ ok: false, status: 409, code: "already_pending" });
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("Finalize is refused inside the waiting period and sent after it; the decline is then allowed", async () => {
    const { db, adverse } = memoryDb(appRow());
    await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    const early = await finalizeAdverseAction(db, { user: manager, applicationId: "app-1", origin });
    expect(early).toMatchObject({ ok: false, status: 409, code: "waiting_period" });
    expect(h.emit).toHaveBeenCalledTimes(1);

    // The window passes.
    adverse[0]!.final_due_at = new Date(Date.now() - 60_000).toISOString();
    const done = await finalizeAdverseAction(db, { user: manager, applicationId: "app-1", origin });
    expect(done).toMatchObject({ ok: true, status: { stage: "finalized", declineAllowed: true } });
    expect(h.emit).toHaveBeenCalledTimes(2);
    const final = h.emit.mock.calls[1]![1];
    expect(final.event).toBe("application_final_adverse_action");
    const text = final.recipients.find((r: { audience: string }) => r.audience === "resident").rendered.text as string;
    expect(text).toMatch(/did not make this decision/);
    expect(text).toMatch(/unable to provide the specific reasons/);
    expect(adverse[0]).toMatchObject({ stage: "finalized" });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "adverse_action_final_sent" }));
    expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow() as DemoApplicantRow }, { bucket: "rejected" })).toBe("no");
    // Finalizing twice sends nothing more.
    await finalizeAdverseAction(db, { user: manager, applicationId: "app-1", origin });
    expect(h.emit).toHaveBeenCalledTimes(2);
  });

  it("Finalize with no pre-adverse notice is refused", async () => {
    const { db } = memoryDb(appRow());
    expect(await finalizeAdverseAction(db, { user: manager, applicationId: "app-1", origin })).toMatchObject({ ok: false, code: "not_pre_adverse" });
  });

  it("withdrawing the notice tells the applicant and keeps the decline blocked until a new answer", async () => {
    const { db, adverse } = memoryDb(appRow());
    await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    const canceled = await cancelAdverseAction(db, { user: manager, applicationId: "app-1" });
    expect(canceled).toMatchObject({ ok: true, status: { stage: "canceled", declineAllowed: false } });
    expect(adverse[0]).toMatchObject({ stage: "canceled" });
    expect(h.emit.mock.calls[1]![1].event).toBe("application_adverse_action_canceled");
    expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow() as DemoApplicantRow }, { bucket: "rejected" })).toBe("blocked");
    // A fresh answer may then be recorded.
    const next = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: false, origin });
    expect(next).toMatchObject({ ok: true, status: { stage: "not_based", declineAllowed: true } });
  });

  it("a notice that cannot be delivered is not recorded as sent", async () => {
    h.emit.mockResolvedValue({ eventId: "e", duplicate: false, delivered: 0, submitted: 0, deferred: 0, failed: 1 });
    const { db, adverse } = memoryDb(appRow());
    const result = await decideAdverseAction(db, { user: manager, applicationId: "app-1", basedOnReport: true, origin });
    expect(result).toMatchObject({ ok: false, status: 502, code: "notice_failed" });
    expect(adverse[0]).toMatchObject({ stage: "canceled" });
  });
});

describe("authority and the write backstop", () => {
  it("only the owner, an admin or a co-manager with applications edit may answer", async () => {
    const { db } = memoryDb(appRow());
    expect(await decideAdverseAction(db, { user: { id: "stranger" }, applicationId: "app-1", basedOnReport: false, origin })).toMatchObject({ ok: false, status: 403 });
    h.coManager.mockResolvedValue(true);
    expect(await decideAdverseAction(db, { user: { id: "co-1" }, applicationId: "app-1", basedOnReport: false, origin })).toMatchObject({ ok: true });
    expect(h.coManager).toHaveBeenCalledWith(expect.anything(), "co-1", "prop-1", "applications", "edit");
  });

  it("the decline write is refused with no answer, never for a non-decline, and fails closed on an unreadable state", async () => {
    const { db } = memoryDb(appRow());
    const stored = { id: "app-1", row_data: appRow() as DemoApplicantRow };
    expect(await adverseActionDeclineBlocker(db, stored, { bucket: "rejected" })).toBe("blocked");
    expect(await adverseActionDeclineBlocker(db, stored, { bucket: "approved" })).toBe("no");
    expect(await adverseActionDeclineBlocker(db, { id: "app-1", row_data: appRow({ bucket: "rejected" }) as DemoApplicantRow }, { bucket: "rejected" })).toBe("no");
    expect(await adverseActionDeclineBlocker(db, { id: "", row_data: { ...appRow(), id: "" } as DemoApplicantRow }, { bucket: "rejected" })).toBe("unchecked");
  });
});
