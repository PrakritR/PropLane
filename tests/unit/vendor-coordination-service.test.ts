import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ retryDueActionEventDeliveries: vi.fn(async () => ({ attempted: 0 })) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { applyCoordinationAction, listCoordination, type CoordinationActor } from "@/lib/vendor-coordination.server";
import { coordinationRequestSchema } from "@/lib/vendor-coordination-input";
const owner: CoordinationActor = { role: "manager", userId: "owner", email: "owner@test.invalid" };
function database(records: Record<string, unknown[]>) {
  const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (records[table] ?? []).filter((row) => filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value));
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, in: () => query, order: () => query, maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }), then: (resolve: (value: unknown) => void) => Promise.resolve({ data: rows(), error: null }).then(resolve) };
    return query;
  });
  return { from, rpc };
}
const proposal = { id: "proposal", work_order_id: "work", manager_user_id: "owner", vendor_directory_id: "directory", vendor_user_id: "vendor", labor_cents: 12500, materials_cents: 1000, consultation_fee_cents: 0, scope: "repair", exclusions: "private", source_message_ids: ["sms-secret"] };
const records = { portal_work_order_records: [{ id: "work", manager_user_id: "owner", resident_email: "resident@test.invalid", resident_user_id: "r", row_data: { vendorId: "directory" } }], vendor_coordination_proposals: [proposal] };
describe("authorized shared coordination", () => {
  it("refuses a reused resident email without the original authenticated subject", async () => { const db = database(records); await expect(listCoordination(db as never, { role: "resident", userId: "replacement", email: "resident@test.invalid" }, "work")).rejects.toThrow("Forbidden"); expect(db.rpc).not.toHaveBeenCalled(); });
  it("refuses an unbound resident record even when the email matches", async () => { const db = database({ ...records, portal_work_order_records: [{ ...records.portal_work_order_records[0], resident_user_id: null }] }); await expect(listCoordination(db as never, { role: "resident", userId: "r", email: "resident@test.invalid" }, "work")).rejects.toThrow("Forbidden"); });

  it("refuses a foreign manager before RPC", async () => { const db = database(records); await expect(applyCoordinationAction(db as never, { ...owner, userId: "stranger" }, { kind: "approve_manager", proposal_id: "proposal", expected_version: 3 })).rejects.toThrow("Forbidden"); expect(db.rpc).not.toHaveBeenCalled(); });
  it("refuses vendor booking authority before reads or RPC", async () => { const db = database(records); await expect(applyCoordinationAction(db as never, { role: "vendor", userId: "vendor", email: "v@test.invalid" }, { kind: "approve_manager", proposal_id: "proposal", expected_version: 3 })).rejects.toThrow("Forbidden"); expect(db.rpc).not.toHaveBeenCalled(); expect(db.from).not.toHaveBeenCalled(); });
  it("does not disclose quote amounts or source messages to a resident", async () => { const db = database(records); const result = await listCoordination(db as never, { role: "resident", userId: "r", email: "resident@test.invalid" }, "work"); expect(result[0].labor_cents).toBeNull(); expect(result[0].scope).toBeNull(); expect(result[0].source_message_ids).toEqual([]); });
  it("pins authenticated actor rather than a caller-supplied identity", async () => { const db = database(records); await applyCoordinationAction(db as never, owner, { kind: "approve_manager", proposal_id: "proposal", expected_version: 3, actor_user_id: "stranger" }); expect(db.rpc.mock.calls[0]).toEqual(["vendor_coordination_action", { p_action: expect.objectContaining({ actor_user_id: "owner", expected_version: 3 }) }]); });
});
describe("coordination API inputs", () => {
  it("rejects identity injection and missing offset dates", () => { expect(() => coordinationRequestSchema.parse({ kind: "confirm_resident", proposal_id: "a3d450d7-1c26-42ec-a09a-5a52d5c57b62", expected_version: 1, resident_email: "other@test.invalid" })).toThrow(); expect(() => coordinationRequestSchema.parse({ kind: "select_time", proposal_id: "a3d450d7-1c26-42ec-a09a-5a52d5c57b62", expected_version: 1, selected_start_iso: "2026-10-05T09:00:00" })).toThrow(); });
  it("rejects fractional cents and inverted windows", () => { expect(() => coordinationRequestSchema.parse({ kind: "revise_quote", proposal_id: "a3d450d7-1c26-42ec-a09a-5a52d5c57b62", expected_version: 1, duration_minutes: 60, quote: { laborCents: 5.5, materialsCents: 0, consultationFeeCents: 0, scope: "Fix", exclusions: "" } })).toThrow(); });
});

import { dollarsToVisitCents, pacificVisitInstant } from "@/lib/vendor-coordination-portal-input.server";
describe("ordinary Pacific scheduling and dollar input", () => {
  it("converts normal dollars server-side without floating point rounding", () => { expect(dollarsToVisitCents("250.01")).toBe(25001); expect(() => dollarsToVisitCents("250.005")).toThrow(); });
  it("uses Pacific rather than the laptop timezone and rejects DST gaps/folds", () => { expect(pacificVisitInstant("2026-10-08T09:00")).toBe("2026-10-08T16:00:00.000Z"); expect(() => pacificVisitInstant("2026-03-08T02:30")).toThrow(); expect(() => pacificVisitInstant("2026-11-01T01:30")).toThrow(); });
});
