/**
 * Unit-level timing of one manager SMS turn with a scripted model: the model asks for three resident tools at once
 * (the loop runs them together), then a charge preview. The db charges 20 ms per round trip and counts them, so the
 * numbers printed here are the before/after of the read fan-out (no network model in the loop).
 */
import { describe, expect, it, vi } from "vitest";
import { makeManagerRowsCtx, type FakeRecord } from "../tools/fake-agent-ctx";

vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCalendarAccessForProperty: vi.fn(async () => true),
  managerCalendarReadableProperties: vi.fn(async (_db: unknown, _user: string, ids: readonly string[]) => new Set(ids)),
  managerCanWriteCalendarForProperty: vi.fn(async () => true),
}));

import { buildRegistry, previewWriteTool, runReadTool } from "@/lib/tools/registry";
import { getResidentSnapshotTool } from "@/lib/tools/domains/manager-questions";
import { listLeasesTool } from "@/lib/tools/domains/leases";
import { listResidentsTool } from "@/lib/tools/domains/residents";
import { createChargeTool } from "@/lib/tools/domains/charges";

const M = "manager_a";
const DELAY_MS = 20;
const rec = (data: Record<string, unknown>, extra: Record<string, unknown> = {}): FakeRecord => ({ id: String(data.id), manager_user_id: M, row_data: data, ...extra }) as FakeRecord;
const tables = {
  manager_property_records: [
    { id: "p5259", manager_user_id: M, row_data: { title: "5259 Brooklyn Ave NE" }, property_data: { title: "5259 Brooklyn Ave NE", listingSubmission: { rooms: [{ id: "rm2", name: "Room 2" }] } } },
  ] as unknown as FakeRecord[],
  manager_application_records: [rec({ id: "a1", name: "Dev Receipt", email: "dev@x.test", bucket: "approved", property: "5259 Brooklyn Ave NE", assignedRoomChoice: "p5259::rm2" })],
  portal_lease_pipeline_records: [rec({ id: "L1", residentName: "Dev Receipt", residentEmail: "dev@x.test", status: "Fully Signed" })],
  portal_household_charge_records: [rec({ id: "c1", kind: "rent", status: "pending", amountLabel: "$1000.00", balanceLabel: "$1000.00", residentEmail: "dev@x.test" })],
};

/** A db whose every round trip costs DELAY_MS and is counted, wrapped around the fake query builder. */
function slowCtx() {
  const ctx = makeManagerRowsCtx(tables);
  const base = ctx.db as unknown as { from: (t: string) => object };
  const trips: string[] = [];
  const terminal = new Set(["range", "maybeSingle", "single", "then"]);
  (ctx as unknown as { db: unknown }).db = {
    from(table: string) {
      const q = base.from(table) as Record<string, (...a: unknown[]) => unknown>;
      const wrap = (target: Record<string, (...a: unknown[]) => unknown>): object =>
        new Proxy(target, {
          get(t, prop: string) {
            const fn = t[prop];
            if (typeof fn !== "function") return fn;
            if (terminal.has(prop)) {
              return (...args: unknown[]) => {
                trips.push(table);
                return new Promise((resolve) => setTimeout(resolve, DELAY_MS)).then(() => fn.apply(t, args));
              };
            }
            return (...args: unknown[]) => {
              const out = fn.apply(t, args);
              return out === t ? wrap(t) : out;
            };
          },
        });
      return wrap(q);
    },
  };
  return { ctx, trips };
}

const registry = buildRegistry([getResidentSnapshotTool, listLeasesTool, listResidentsTool, createChargeTool] as never[]);

async function scriptedTurn() {
  const { ctx, trips } = slowCtx();
  const started = performance.now();
  // Model response 1: three read tools at once (the loop runs a response's tool calls together).
  const [snapshot, leases, residents] = await Promise.all([
    runReadTool(registry, ctx, "get_resident_snapshot", { q: "5259 Room 2" }),
    runReadTool(registry, ctx, "list_leases", { resident: "5259 Room 2" }),
    runReadTool(registry, ctx, "list_residents", { q: "5259 Room 2" }),
  ]);
  // Model response 2: a charge preview for the same resident.
  const preview = await previewWriteTool(registry, ctx, "create_charge", { residentEmail: "5259 Room 2", kind: "other_cost", title: "Lockout", amountUsd: 25 });
  const ms = Math.round(performance.now() - started);
  return { snapshot, leases, residents, preview, ms, trips };
}

describe("manager SMS turn read fan-out (scripted model, 20 ms per round trip)", () => {
  it("answers every tool from one read per table and reports the timing", async () => {
    const out = await scriptedTurn();
    const perTable = out.trips.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});
    console.log(`[turn-latency] ${out.ms} ms, ${out.trips.length} round trips`, JSON.stringify(perTable));

    expect(out.snapshot).toMatchObject({ ok: true, data: { count: 1 } });
    expect(out.leases).toMatchObject({ ok: true, data: { count: 1 } });
    expect(out.residents).toMatchObject({ ok: true, data: { count: 1 } });
    expect(out.preview).toMatchObject({ ok: true, input: { residentEmail: "dev@x.test" } });

    // Each heavy table is read once for the whole turn, however many tools touch it.
    expect(perTable.manager_application_records).toBe(1);
    expect(perTable.portal_lease_pipeline_records).toBe(1);
    expect(perTable.portal_household_charge_records ?? 0).toBeLessThanOrEqual(1);
    expect(perTable.manager_property_records).toBe(1);
  });
});
