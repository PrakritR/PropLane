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

describe("service workspace without a signed fee policy", () => {
  it("is found for an unsigned service house only", async () => {
    const f = world();
    expect(await unpoliciedServiceForProperties(f.db, ["p-svc"])).toEqual([{ workspaceId: "ws-svc", workspaceName: "Maple Court" }]);
    expect(await unpoliciedServiceForProperties(f.db, ["p-signed", "p-self", "p-none", ""])).toEqual([]);
  });

  it("is a draft or ended policy, not an active one: still unsigned", async () => {
    const f = world({ managed_workspace_fee_policies: [{ ...activePolicy("ws-svc"), status: "draft", signed_at: null }] });
    expect(await unpoliciedServiceForProperties(f.db, ["p-svc"])).toHaveLength(1);
  });

  it("refuses the resident checkout with the setup message and raises one admin flag", async () => {
    const f = world();
    expect(await serviceSetupPendingProblem(f.db, ["p-svc"])).toBe(SERVICE_SETUP_PENDING_MESSAGE);
    expect(SERVICE_SETUP_PENDING_MESSAGE).toContain("being set up");
    const flags = f.rows.owner_ledger_flags ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ check_name: "fee_agreement_unsigned", subject: "ws-svc" });
    expect((flags[0]!.detail as { message: string }).message).toBe("Sign the fee agreement for Maple Court");
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
    expect(await serviceSetupPendingProblem(db, ["p-svc"])).toMatch(/Could not confirm/);
    void f;
  });

  it("the manager of record of an unsigned service house is flagged, a self-serve-only manager is not", async () => {
    const f = world();
    expect((await unpoliciedServiceForManager(f.db, MANAGER)).map((w) => w.workspaceId)).toEqual(["ws-svc"]);
    const g = world({ manager_property_records: [{ id: "p-self", manager_user_id: "other", workspace_id: "ws-self" }] });
    expect(await unpoliciedServiceForManager(g.db, "other")).toEqual([]);
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

describe("hold release is frozen for an unsigned service workspace", () => {
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
