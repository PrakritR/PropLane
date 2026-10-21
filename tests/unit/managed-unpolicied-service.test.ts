/**
 * A service workspace (is_service) with no ACTIVE signed fee policy is not "managed", so its rent would be captured for the manager
 * of record and paid to that person's personal Connect account. Until the agreement is signed: no new checkout, no hold release,
 * an admin flag, and platform capture (never a destination charge) for application and form fees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

vi.mock("@/lib/stripe-connect", () => ({ connectAccountReadyForAchPayouts: () => true }));

import {
  platformCaptureRequiredForProperty,
  SERVICE_SETUP_PENDING_MESSAGE,
  serviceSetupPendingProblem,
  unpoliciedServiceForManager,
  unpoliciedServiceForProperties,
} from "@/lib/managed-finance/unpolicied-service.server";
import { releaseVerifiedPlatformHoldsForOwner } from "@/lib/platform-hold-release.server";

const MANAGER = "mgr-1";
const activePolicy = (workspace: string): FakeRow => ({
  id: `pol-${workspace}`, workspace_id: workspace, owner_user_id: "own-1", status: "active", signed_at: "2026-01-01T00:00:00Z",
  owner_share_bps: 9000, applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 0,
  repair_approval_threshold_cents: 25_000, effective_from: "2026-01-01", accepted_via: "owner_signature", terms_sha256: "h", created_at: "2026-01-01",
});

function world(over: Record<string, FakeRow[]> = {}) {
  return fakeOwnerDb({
    portal_workspaces: [
      { id: "ws-svc", name: "Maple Court", is_service: true, owner_user_id: "client-1" },
      { id: "ws-signed", name: "Pine Row", is_service: true, owner_user_id: "client-2" },
      { id: "ws-self", name: "Self serve", is_service: false, owner_user_id: MANAGER },
    ],
    manager_property_records: [
      { id: "p-svc", manager_user_id: MANAGER, workspace_id: "ws-svc" },
      { id: "p-signed", manager_user_id: MANAGER, workspace_id: "ws-signed" },
      { id: "p-self", manager_user_id: MANAGER, workspace_id: "ws-self" },
      { id: "p-none", manager_user_id: MANAGER, workspace_id: null },
    ],
    managed_workspace_fee_policies: [activePolicy("ws-signed")],
    ...over,
  });
}

describe("service workspace whose automatic fee could not be created (fail-closed fallback)", () => {
  it("is found for an unsigned service house only", async () => {
    const f = world();
    expect((await unpoliciedServiceForProperties(f.db, ["p-svc"])).pending).toEqual([{ workspaceId: "ws-svc", workspaceName: "Maple Court", cause: "no_owner" }]);
    expect((await unpoliciedServiceForProperties(f.db, ["p-signed", "p-self", "p-none", ""])).pending).toEqual([]);
  });

  it("is a draft or ended policy, not an active one: still unsigned", async () => {
    const f = world({ managed_workspace_fee_policies: [{ ...activePolicy("ws-svc"), status: "draft", signed_at: null }] });
    expect((await unpoliciedServiceForProperties(f.db, ["p-svc"])).pending).toHaveLength(1);
  });

  it("refuses the resident checkout with the setup message and raises one admin flag", async () => {
    const f = world();
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toEqual({ code: "SERVICE_SETUP_PENDING", message: SERVICE_SETUP_PENDING_MESSAGE });
    expect(SERVICE_SETUP_PENDING_MESSAGE).toContain("being set up");
    const flags = f.rows.owner_ledger_flags ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ check_name: "fee_agreement_unsigned", subject: "ws-svc" });
    expect((flags[0]!.detail as { message: string }).message).toContain("Maple Court");
    expect((flags[0]!.detail as { message: string }).message).not.toMatch(/sign/i);
    expect(flags[0]!.detail).toMatchObject({ cause: "no_owner" });
    await serviceSetupPendingProblem(f.db, ["p-svc"]);
    expect(f.rows.owner_ledger_flags).toHaveLength(1); // one flag per workspace per day
  });

  it("lets a signed service workspace and a self-serve house through", async () => {
    const f = world();
    expect(await serviceSetupPendingProblem(f.db, ["p-signed"])).toBeNull();
    expect(await serviceSetupPendingProblem(f.db, ["p-self"])).toBeNull();
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
  });

  it("fails closed when the read fails", async () => {
    const f = world();
    const db = { from: () => { throw new Error("boom"); } } as never;
    expect(await serviceSetupPendingProblem(db, ["p-svc"])).toMatchObject({ code: "SERVICE_SETUP_PENDING", message: expect.stringMatching(/Could not confirm/) });
    void f;
  });

  it("the manager of record of an unsigned service house is flagged, a self-serve-only manager is not", async () => {
    const f = world();
    expect((await unpoliciedServiceForManager(f.db, MANAGER)).pending.map((w) => w.workspaceId)).toEqual(["ws-svc"]);
    const g = world({ manager_property_records: [{ id: "p-self", manager_user_id: "other", workspace_id: "ws-self" }] });
    expect((await unpoliciedServiceForManager(g.db, "other")).pending).toEqual([]);
  });

  it("platform capture is required for managed and unsigned-service houses, never for self-serve", async () => {
    const f = world();
    expect(await platformCaptureRequiredForProperty(f.db, "p-signed")).toBe(true);
    expect(await platformCaptureRequiredForProperty(f.db, "p-svc")).toBe(true);
    expect(await platformCaptureRequiredForProperty(f.db, "p-self")).toBe(false);
    expect(await platformCaptureRequiredForProperty(f.db, null)).toBe(false);
    expect(await platformCaptureRequiredForProperty({ from: () => { throw new Error("x"); } } as never, "p-self")).toBe(true);
  });
});

/** Mirrors `activate_managed_policy` closely enough for the callers: end the old active row, activate the draft. */
const activateRpc = (args: Record<string, unknown>, f: { rows: Record<string, FakeRow[]> }) => {
  const rows = f.rows.managed_workspace_fee_policies!;
  const row = rows.find((r) => r.id === args.p_id)!;
  for (const other of rows) if (other.workspace_id === row.workspace_id && other.status === "active") other.status = "ended";
  Object.assign(row, { status: "active", signed_at: "2026-10-20T00:00:00Z", accepted_via: args.p_via, terms_sha256: args.p_hash });
  return { status: "active" };
};
function autoWorld() {
  return fakeOwnerDb(
    {
      portal_workspaces: [{ id: "ws-svc", name: "Maple Court", is_service: true, owner_user_id: "client-1" }],
      platform_service_settings: [{ singleton: true, owner_user_id: "svc-owner" }],
      manager_property_records: [{ id: "p-svc", manager_user_id: "client-1", workspace_id: "ws-svc" }],
      managed_workspace_fee_policies: [],
    },
    { rpc: { activate_managed_policy: activateRpc } },
  );
}

describe("a service workspace without a policy gets its automatic fee instead of a refusal", () => {
  it("the first checkout creates the policy and proceeds, with no admin flag", async () => {
    const f = autoWorld();
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toBeNull();
    const policies = f.rows.managed_workspace_fee_policies!;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ status: "active", owner_user_id: "client-1", owner_share_bps: 9000, accepted_via: "admin_attested" });
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
    // The next checkout reuses it.
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toBeNull();
    expect(f.rpcCalls.filter((c) => c.name === "activate_managed_policy")).toHaveLength(1);
  });

  // Review fix (L4): the checkout guard asked for the version in force on `now.toISOString()`'s day - the UTC one,
  // which after 17:00 Pacific is already tomorrow. A version whose window still covered that Pacific evening read as
  // gone, and the guard went off to create a SECOND policy for a workspace that already had one in force.
  it("reads the version in force on the PACIFIC day, not the UTC one, at 18:00 Pacific", async () => {
    // A legacy retired row: `ends_on` stamped from the database's UTC `current_date` and no `ended_at` to correct it,
    // so its window runs to Oct 21 and still covers the Pacific evening of Oct 20.
    const f = autoWorld();
    f.rows.managed_workspace_fee_policies!.push({
      ...activePolicy("ws-svc"), status: "ended", ends_on: "2026-10-21", ended_at: null,
      effective_from: "2026-10-01", owner_user_id: "client-1",
    });
    // 18:00 Pacific on Oct 20 is already Oct 21 in UTC.
    const evening = new Date("2026-10-21T01:00:00Z");
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"], evening)).toBeNull();
    // The version in force was found, so nothing was created and no operator was paged.
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
    expect(f.rpcCalls.filter((c) => c.name === "activate_managed_policy")).toHaveLength(0);
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
    // The day after that window really does close: the workspace needs a fee again.
    const next = new Date("2026-10-21T19:00:00Z");
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"], next)).toBeNull();
    expect(f.rpcCalls.filter((c) => c.name === "activate_managed_policy")).toHaveLength(1);
  });

  it("the first payment is captured on the platform balance, never a destination charge", async () => {
    const f = autoWorld();
    expect(await platformCaptureRequiredForProperty(f.db, "p-svc")).toBe(true);
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
  });

  it("a hold release is no longer frozen once the policy exists (it proceeds to verification)", async () => {
    const f = autoWorld();
    Object.assign(f.rows, {
      platform_payment_holds: [{
        id: "hold-1", owner_user_id: "client-1", owner_role: "manager", source: "household_charge", source_id: "cs_1", amount_cents: 5000,
        status: "classified_held", stripe_charge_id: "ch_1", original_amount_cents: 5000, source_charge_gross_cents: 5000,
        source_payment_intent_id: "pi_1", source_verified_at: "2026-10-01T00:00:00Z",
      }],
      platform_hold_transfer_attempts: [],
    });
    const charges = { retrieve: vi.fn(async () => { throw new Error("verification reached"); }) };
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db, { ownerUserId: "client-1", stripe: { charges, accounts: {}, transfers: {} } as never })).rejects.toThrow();
    expect(charges.retrieve).toHaveBeenCalled();
  });

  it("a workspace with no owner of record is still refused (fail closed) and flagged", async () => {
    const f = fakeOwnerDb(
      {
        portal_workspaces: [{ id: "ws-svc", name: "Maple Court", is_service: true, owner_user_id: "svc-owner" }],
        platform_service_settings: [{ singleton: true, owner_user_id: "svc-owner" }],
        manager_property_records: [{ id: "p-svc", manager_user_id: "svc-owner", workspace_id: "ws-svc" }],
        managed_workspace_fee_policies: [],
      },
      { rpc: { activate_managed_policy: activateRpc } },
    );
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toEqual({ code: "SERVICE_SETUP_PENDING", message: SERVICE_SETUP_PENDING_MESSAGE });
    expect(f.rows.owner_ledger_flags).toHaveLength(1);
    expect((f.rows.owner_ledger_flags![0]!.detail as { cause: string }).cause).toBe("no_owner");
  });

  // Review fix, Oct 20: the cart was re-resolved on EVERY call, including self-serve carts that touch no service
  // workspace, and a mixed-cart answer came back labelled SERVICE_SETUP_PENDING. It is re-checked only when a policy
  // was actually created a moment ago, and it says which refusal it is.
  it("re-checks the cart only when a policy was just created, and labels a mixed cart as such", async () => {
    const f = autoWorld();
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toBeNull();
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
    // Nothing was created this time, so nothing is re-resolved and the answer is still "go ahead".
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toBeNull();
  });

  it("a cart that mixes the just-created managed workspace with a plain house is refused as MIXED_PAYMENT_SETUP", async () => {
    const f = fakeOwnerDb(
      {
        portal_workspaces: [{ id: "ws-svc", name: "Maple Court", is_service: true, owner_user_id: "client-1" }],
        platform_service_settings: [{ singleton: true, owner_user_id: "svc-owner" }],
        manager_property_records: [
          { id: "p-svc", manager_user_id: "client-1", workspace_id: "ws-svc" },
          { id: "p-plain", manager_user_id: "client-1", workspace_id: null },
        ],
        managed_workspace_fee_policies: [],
      },
      { rpc: { activate_managed_policy: activateRpc } },
    );
    expect(await serviceSetupPendingProblem(f.db, ["p-svc", "p-plain"])).toMatchObject({ code: "MIXED_PAYMENT_SETUP" });
  });
});

describe("hold release is frozen when a service workspace could not be given its fee", () => {
  const verifiedHold = {
    id: "hold-1", owner_user_id: MANAGER, owner_role: "manager", source: "household_charge", source_id: "cs_1", amount_cents: 5000,
    status: "classified_held", stripe_charge_id: "ch_1", original_amount_cents: 5000, source_charge_gross_cents: 5000,
    source_payment_intent_id: "pi_1", source_verified_at: "2026-10-01T00:00:00Z",
  };
  const stripe = () => ({
    accounts: { retrieve: vi.fn(async () => { throw new Error("must not reach Stripe"); }) },
    charges: { retrieve: vi.fn(async () => { throw new Error("must not reach Stripe"); }) },
    transfers: { create: vi.fn() },
  });
  beforeEach(() => vi.clearAllMocks());

  it("does not verify, reserve or transfer; the hold stays visible as pending; an admin flag is raised", async () => {
    const f = world({ platform_payment_holds: [verifiedHold], platform_hold_transfer_attempts: [] });
    const s = stripe();
    const result = await releaseVerifiedPlatformHoldsForOwner(f.db, { ownerUserId: MANAGER, stripe: s as never });
    expect(result).toEqual({ transferred: 0, pending: 1 });
    expect(s.transfers.create).not.toHaveBeenCalled();
    expect(s.charges.retrieve).not.toHaveBeenCalled();
    expect(f.rpcCalls.filter((c) => c.name === "reserve_platform_hold_transfer")).toHaveLength(0);
    expect((f.rows.owner_ledger_flags ?? []).some((r) => r.check_name === "fee_agreement_unsigned")).toBe(true);
  });

  it("proceeds (to verification) once the fee agreement is signed", async () => {
    const f = world({
      platform_payment_holds: [verifiedHold], platform_hold_transfer_attempts: [],
      managed_workspace_fee_policies: [activePolicy("ws-signed"), activePolicy("ws-svc")],
    });
    const s = stripe();
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db, { ownerUserId: MANAGER, stripe: s as never })).rejects.toThrow();
    expect(s.charges.retrieve).toHaveBeenCalled();
  });

  it("a manager with only self-serve houses is not frozen", async () => {
    const f = world({
      portal_workspaces: [{ id: "ws-self", is_service: false, owner_user_id: MANAGER }],
      manager_property_records: [{ id: "p-self", manager_user_id: MANAGER, workspace_id: "ws-self" }],
      platform_payment_holds: [verifiedHold], platform_hold_transfer_attempts: [],
    });
    const s = stripe();
    await expect(releaseVerifiedPlatformHoldsForOwner(f.db, { ownerUserId: MANAGER, stripe: s as never })).rejects.toThrow();
    expect(s.charges.retrieve).toHaveBeenCalled();
  });
});
