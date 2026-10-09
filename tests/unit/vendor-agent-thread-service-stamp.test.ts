import { describe, expect, it, vi } from "vitest";
import { normalizeRecordRef } from "@/lib/portals/record-kinds";
import { threadAboutService } from "@/lib/service-communication-scope";

/**
 * Plan admin-money-1008, D9: a dispatch-agent conversation is about a service. Its inbox thread is stamped with
 * `{kind: "service", id: <work order>}` and the work order id when the session is created, and a thread made
 * before the stamp existed gets it the next time the session is refreshed - otherwise the service's
 * Communication, which shows only threads stamped with that service, never lists it.
 */
vi.mock("server-only", () => ({}));

import { ensureVendorAgentSession, vendorAgentThreadServiceStamp } from "@/lib/agent/vendor-agent.server";

const ARGS = {
  landlordId: "owner-1",
  workOrderId: "wo-9",
  vendorDirectoryId: "d1",
  vendorUserId: "vendor-user-1",
  vendorName: "Pacific Plumbing",
  workOrderTitle: "Kitchen faucet drip",
  propertyLabel: "Alder House",
};
const threadId = "vendor_agent_wo-9_d1";

type Row = Record<string, unknown>;

/** The few PostgREST shapes `ensureVendorAgentSession` uses: select/eq/maybeSingle, update/eq, upsert/select/single. */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = seed;
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const query = (read: () => Row[]) => {
      const filters: [string, unknown][] = [];
      const hits = () => read().filter((row) => filters.every(([col, val]) => row[col] === val));
      const builder: Record<string, unknown> = {
        eq: (col: string, val: unknown) => (filters.push([col, val]), builder),
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: hits()[0] ?? null, error: null }),
        single: async () => ({ data: hits()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: hits(), error: null }).then(resolve),
      };
      return builder;
    };
    return {
      select: () => query(() => rows),
      update: (patch: Row) => {
        const filters: [string, unknown][] = [];
        const builder: Record<string, unknown> = {
          eq: (col: string, val: unknown) => (filters.push([col, val]), builder),
          then: (resolve: (v: { error: null }) => unknown) => {
            for (const row of rows) if (filters.every(([col, val]) => row[col] === val)) Object.assign(row, patch);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      },
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        const keys = (opts?.onConflict ?? "id").split(",").map((k) => k.trim());
        const existing = rows.find((candidate) => keys.every((k) => candidate[k] === row[k]));
        const stored = existing ? Object.assign(existing, row) : (rows.push({ ...row }), rows[rows.length - 1]!);
        const done = Promise.resolve({ error: null });
        return Object.assign(done, { select: () => query(() => [stored]) });
      },
    };
  };
  return { from, tables };
}

describe("vendorAgentThreadServiceStamp", () => {
  it("is the service recordRef and the work order id", () => {
    const stamp = vendorAgentThreadServiceStamp("wo-9", "Kitchen faucet drip");
    expect(stamp).toEqual({ workOrderId: "wo-9", recordRef: { kind: "service", id: "wo-9", label: "Kitchen faucet drip" } });
    expect(normalizeRecordRef(stamp.recordRef)).not.toBeNull();
  });
  it("never leaves the label empty", () => {
    expect(vendorAgentThreadServiceStamp("wo-9", "  ").recordRef?.label).toBe("Service");
  });
});

describe("ensureVendorAgentSession", () => {
  it("stamps the new vendor thread with the service, so the service's Communication matches it", async () => {
    const db = fakeDb({ agent_sessions: [], portal_inbox_thread_records: [] });
    const session = await ensureVendorAgentSession(db as never, ARGS);
    expect(session?.inbox_thread_id).toBe(threadId);
    const row = db.tables.portal_inbox_thread_records!.find((r) => r.id === threadId)!;
    const rowData = row.row_data as Row;
    expect(rowData.recordRef).toEqual({ kind: "service", id: "wo-9", label: "Kitchen faucet drip" });
    expect(rowData.workOrderId).toBe("wo-9");
    expect(threadAboutService({ ...rowData, id: threadId } as never, new Set(["wo-9"]))).toBe(true);
    // Another job with the same vendor is not this thread.
    expect(threadAboutService({ ...rowData, id: threadId } as never, new Set(["wo-10"]))).toBe(false);
  });

  it("stamps a thread that already existed without one, and leaves an existing recordRef alone", async () => {
    const db = fakeDb({
      agent_sessions: [
        { id: "s1", landlord_id: "owner-1", kind: "vendor_work_order", vendor_user_id: "vendor-user-1", vendor_directory_id: "d1", work_order_id: "wo-9", status: "active", inbox_thread_id: threadId },
      ],
      portal_inbox_thread_records: [
        { id: threadId, scope: "axis_portal_inbox_vendor_v1", owner_user_id: "vendor-user-1", participant_email: null, thread_type: "vendor_agent", row_data: { id: threadId, messages: [] } },
      ],
    });
    await ensureVendorAgentSession(db as never, ARGS);
    const rowData = db.tables.portal_inbox_thread_records!.find((r) => r.id === threadId)!.row_data as Row;
    expect(rowData.recordRef).toEqual({ kind: "service", id: "wo-9", label: "Kitchen faucet drip" });
    expect(rowData.workOrderId).toBe("wo-9");

    // A second refresh with another title does not relabel the ref it already carries.
    await ensureVendorAgentSession(db as never, { ...ARGS, workOrderTitle: "Renamed" });
    expect((db.tables.portal_inbox_thread_records!.find((r) => r.id === threadId)!.row_data as Row).recordRef).toEqual({ kind: "service", id: "wo-9", label: "Kitchen faucet drip" });
  });
});
