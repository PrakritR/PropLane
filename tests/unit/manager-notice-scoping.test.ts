import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { roomDateBlockStays } from "@/lib/reminders/subjects/bookings.server";
import { listRecentLeadsTool } from "@/lib/tools/domains/manager-ops";
import { CO_MANAGER_SCOPED_TOOLS } from "@/lib/tools/manager-co-manager-tool-scope";

/** A tiny chainable fake: every filter method returns itself and the terminal resolves to the rows. */
function fakeDb(tables: Record<string, unknown[]>, seen: Array<{ table: string; filters: Array<[string, unknown]> }> = []) {
  return {
    from(table: string) {
      const rec = { table, filters: [] as Array<[string, unknown]> };
      seen.push(rec);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "limit", "not", "is"]) {
        chain[m] = (...args: unknown[]) => {
          if (m === "eq" || m === "in") rec.filters.push([String(args[0]), args[1]]);
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null });
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
      return chain;
    },
  };
}

describe("closed room blocks are not stays", () => {
  it("skips a manager-closed block and a host block; keeps a named guest AND a privacy-stripped 'CLOSED - Not available' reservation", async () => {
    const block = (id: string, rowData: Record<string, unknown>) => ({ id, manager_user_id: "m1", property_id: "p1", row_data: { checkIn: "2026-11-10", checkOut: "2026-11-14", roomId: "r8", ...rowData } });
    const db = fakeDb({
      portal_schedule_records: [
        block("a", { residentName: "CLOSED - Not available", reason: "Airbnb" }),
        block("b", { blockKind: "closed", reason: "Maintenance" }),
        block("c", { residentName: "Priya Nair", reason: "Airbnb" }),
        block("d", { residentName: "Not available", reason: "Airbnb" }),
      ],
    });
    const stays = await roomDateBlockStays(db as never);
    expect(stays.map((s) => s.subjectId).sort()).toEqual(["block:a", "block:c"]);
    expect(stays.find((s) => s.subjectId === "block:c")!.channel).toBe("Airbnb");
  });
});

describe("list_recent_leads scoping", () => {
  it("is scoped to the workspace behind the number and the manager owner; no workspace means nothing", async () => {
    const seen: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const db = fakeDb({ manager_sms_contacts: [{ phone_e164: "+12065554812", display_name: "Maya Rao", created_at: "2026-11-14T10:00:00Z", last_inbound_at: null }] }, seen);
    const ctx = { landlordId: "m1", userId: "m1", db, workspace: { id: "ws1", propertyIds: [] } } as never;
    const out = (await listRecentLeadsTool.handler(ctx, { sinceDays: 7, limit: 10 } as never)) as { count: number; leads: Array<{ phoneLast4: string }> };
    expect(out.count).toBe(1);
    expect(out.leads[0]!.phoneLast4).toBe("...4812");
    expect(JSON.stringify(out)).not.toContain("2065554812");
    const contacts = seen.find((s) => s.table === "manager_sms_contacts")!;
    expect(contacts.filters).toEqual(expect.arrayContaining([["manager_user_id", "m1"], ["workspace_id", "ws1"], ["counterparty_role", "prospect"]]));
    const none = (await listRecentLeadsTool.handler({ landlordId: "m1", userId: "m1", db } as never, { sinceDays: 7, limit: 10 } as never)) as { count: number };
    expect(none.count).toBe(0);
  });
  it("a delegated teammate sees only leads on a house they hold", async () => {
    const db = fakeDb({
      manager_sms_contacts: [{ phone_e164: "+12065554812", display_name: "Maya Rao", created_at: "2026-11-14T10:00:00Z" }],
      sms_unassigned_leads: [{ phone_key: "2065554812", profile: {}, assigned_property_id: "p-other", assigned_workspace_id: "ws1" }],
    });
    const ctx = { landlordId: "m1", userId: "t1", db, workspace: { id: "ws1", propertyIds: ["p-mine", "p-other"] }, managerSmsAccess: { mode: "delegated", assignedPropertyIds: ["p-mine"] } } as never;
    const out = (await listRecentLeadsTool.handler(ctx, { sinceDays: 7, limit: 10 } as never)) as { count: number };
    expect(out.count).toBe(0);
  });
  it("both new reads are co-manager scoped tools", () => {
    expect(CO_MANAGER_SCOPED_TOOLS.has("list_recent_leads")).toBe(true);
    expect(CO_MANAGER_SCOPED_TOOLS.has("list_stay_moves")).toBe(true);
  });
});
