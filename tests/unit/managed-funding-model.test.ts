import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import {
  FundingModelUnreadableError,
  ServiceWorkspaceHoldRefusedError,
  assertHoldAllowedForProperties,
  fundingModelProblem,
  holdIsServiceWorkspaceMoney,
  resolveFundingModelForProperties,
  resolveWorkspaceFundingModel,
} from "@/lib/managed-finance/funding-model.server";

type Rows = Record<string, Array<Record<string, unknown>>>;

/** A tiny chainable fake: select/eq/in/limit/maybeSingle over in-memory rows; `fail` makes a table's read error. */
function fakeDb(rows: Rows, fail: string[] = []): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const run = () => {
      if (fail.includes(table)) return { data: null, error: { code: "XX000", message: "boom" } };
      return { data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push((r) => (col.includes("->>")
          ? (r.row_data as Record<string, unknown>)?.[col.split("->>")[1]!] === val
          : r[col] === val));
        return q;
      },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; },
      limit: () => q,
      maybeSingle: () => { const r = run(); return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const rows: Rows = {
  portal_workspaces: [{ id: "ws-managed", is_service: true }, { id: "ws-self", is_service: false }],
  manager_property_records: [
    { id: "p-managed", workspace_id: "ws-managed" },
    { id: "p-self", workspace_id: "ws-self" },
    { id: "p-legacy", workspace_id: null },
  ],
  portal_household_charge_records: [
    { id: "c1", manager_user_id: "mgr", row_data: { propertyId: "p-managed", stripeCheckoutSessionId: "cs_managed" } },
    { id: "c2", manager_user_id: "mgr", row_data: { propertyId: "p-self", stripeCheckoutSessionId: "cs_self" } },
  ],
};

describe("workspace funding model", () => {
  it("managed workspace resolves to the platform; self-serve keeps Connect", async () => {
    const db = fakeDb(rows);
    expect(await resolveWorkspaceFundingModel(db, "ws-managed")).toBe("managed_platform");
    expect(await resolveWorkspaceFundingModel(db, "ws-self")).toBe("connect_destination");
    expect(await resolveFundingModelForProperties(db, ["p-managed"])).toBe("managed_platform");
    expect(await resolveFundingModelForProperties(db, ["p-self", "p-legacy"])).toBe("connect_destination");
    expect(await resolveFundingModelForProperties(db, [null, undefined])).toBe("connect_destination");
  });

  it("an unreadable flag is refused, never read as self-serve", async () => {
    await expect(resolveWorkspaceFundingModel(fakeDb(rows, ["portal_workspaces"]), "ws-self")).rejects.toBeInstanceOf(FundingModelUnreadableError);
    await expect(resolveWorkspaceFundingModel(fakeDb(rows), "ws-missing")).rejects.toBeInstanceOf(FundingModelUnreadableError);
    await expect(resolveFundingModelForProperties(fakeDb(rows, ["manager_property_records"]), ["p-self"])).rejects.toBeInstanceOf(FundingModelUnreadableError);
    expect(await fundingModelProblem(fakeDb(rows, ["portal_workspaces"]), ["p-self"])).toMatch(/Could not confirm/);
    expect(await fundingModelProblem(fakeDb(rows), ["p-managed"])).toBeNull();
    expect(await fundingModelProblem(fakeDb(rows), ["p-self"])).toBeNull();
  });

  it("a managed workspace can never be credited to a manager hold; self-serve can", async () => {
    await expect(assertHoldAllowedForProperties(fakeDb(rows), ["p-managed"])).rejects.toBeInstanceOf(ServiceWorkspaceHoldRefusedError);
    await expect(assertHoldAllowedForProperties(fakeDb(rows), ["p-self"])).resolves.toBeUndefined();
    await expect(assertHoldAllowedForProperties(fakeDb(rows, ["portal_workspaces"]), ["p-self"])).rejects.toBeInstanceOf(FundingModelUnreadableError);
  });

  it("a hold of a managed workspace is recognised at release time; unreadable throws", async () => {
    const hold = (source_id: string) => ({ source: "household_charge", source_id, owner_user_id: "mgr" });
    expect(await holdIsServiceWorkspaceMoney(fakeDb(rows), hold("cs_managed"))).toBe(true);
    expect(await holdIsServiceWorkspaceMoney(fakeDb(rows), hold("cs_self"))).toBe(false);
    expect(await holdIsServiceWorkspaceMoney(fakeDb(rows), { ...hold("cs_managed"), source: "vendor_invoice" })).toBe(false);
    await expect(holdIsServiceWorkspaceMoney(fakeDb(rows, ["portal_household_charge_records"]), hold("cs_self"))).rejects.toBeInstanceOf(FundingModelUnreadableError);
  });
});
