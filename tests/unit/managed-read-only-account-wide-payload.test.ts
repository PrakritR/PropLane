/**
 * The managed view-only lock is ACCOUNT-WIDE for the owner of a PropLane-managed workspace:
 * `managed_read_only_owner_locked()` (mirrored by `managedReadOnlyOwnerLocked`) refuses every /api write she
 * makes, in her OWN non-service workspaces too. `PortalWorkspace.readOnly` is the UI half of that one lock, so
 * `loadWorkspaces` has to mark every workspace of a locked owner view-only — otherwise the portal draws create
 * chrome (the round +, Add service) whose write then 403s, which reads as a record that was created.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { loadWorkspaces } from "@/lib/workspaces/server";

type Row = Record<string, unknown>;

/** The chain shapes `loadWorkspaces` and the lock readers issue: select / eq / in / order / maybeSingle / await. */
function fakeTable(rows: Row[]) {
  let current = [...rows];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => ((current = current.filter((r) => r[col] === val)), builder),
    in: (col: string, vals: readonly unknown[]) => ((current = current.filter((r) => vals.includes(r[col] as never))), builder),
    not: (col: string, op: string, val: unknown) =>
      ((current = op === "is" && val === null ? current.filter((r) => r[col] !== null && r[col] !== undefined) : current), builder),
    or: () => builder,
    order: () => builder,
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: current, error: null }).then(resolve, reject),
  };
  return builder;
}

const OWNER = "owner-locked";
const WS_SERVICE = "ws-managed";
const WS_OWN = "ws-her-own";

const PAID_PLAN: Row = {
  user_id: OWNER,
  tier: "pro",
  stripe_subscription_id: "sub_1",
  subscription_status: "active",
  first_paid_at: "2026-10-01T00:00:00Z",
};

function fakeDb(over: { purchases?: Row[]; serviceWorkspace?: boolean } = {}): SupabaseClient {
  const tables: Record<string, Row[]> = {
    portal_workspaces: [
      { id: WS_SERVICE, name: "Ambika", owner_user_id: OWNER, is_default: true, is_service: over.serviceWorkspace !== false },
      { id: WS_OWN, name: "Her own homes", owner_user_id: OWNER, is_default: false, is_service: false },
    ],
    account_link_invites: [],
    profiles: [{ id: OWNER, email: "client@test.local", full_name: "Ambika" }],
    manager_property_records: [{ id: "house-1", workspace_id: WS_OWN, manager_user_id: OWNER, row_data: {}, status: "live" }],
    manager_purchases: over.purchases ?? [],
    profile_roles: [],
    platform_service_settings: [],
  };
  return {
    from(table: string) {
      if (!(table in tables)) throw new Error(`unexpected table: ${table}`);
      return fakeTable(tables[table]!);
    },
  } as unknown as SupabaseClient;
}

describe("the workspaces payload of a locked managed owner", () => {
  it("marks EVERY workspace she has view-only, her own non-service one included", async () => {
    const workspaces = await loadWorkspaces(fakeDb(), OWNER);
    expect(workspaces.map((w) => w.id).sort()).toEqual([WS_OWN, WS_SERVICE]);
    for (const w of workspaces) {
      expect(w.readOnly, w.id).toBe(true);
      expect(w.canAddProperties, w.id).toBe(false);
      expect(w.canManageMembers, w.id).toBe(false);
    }
  });

  it("leaves both writable once she pays for a plan of her own", async () => {
    const workspaces = await loadWorkspaces(fakeDb({ purchases: [PAID_PLAN] }), OWNER);
    for (const w of workspaces) expect(w.readOnly, w.id).toBeUndefined();
    expect(workspaces.find((w) => w.id === WS_OWN)?.canAddProperties).toBe(true);
  });

  it("never locks an owner who has no managed workspace at all", async () => {
    const workspaces = await loadWorkspaces(fakeDb({ serviceWorkspace: false }), OWNER);
    for (const w of workspaces) expect(w.readOnly, w.id).toBeUndefined();
  });
});
