/**
 * Evidence (captain, Oct 20): a PropLane Service workspace gets its management fee on its own - nobody signs anything -
 * and an admin's rate change in Admin > Service applies to what settles from that moment on, while a payment taken
 * earlier still settles on the version in force the day it was taken.
 *
 * It prints the story as it runs so the run itself is the artifact; every line it prints is also asserted.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow, type OwnerFakeDb } from "../helpers/owner-fake-db";

vi.mock("@/lib/stripe-connect", () => ({ connectAccountReadyForAchPayouts: () => true }));

import {
  ensureServiceFeePolicy,
  HAND_AUTHORED_DRAFT_MESSAGE,
  listPoliciesForWorkspace,
  loadActivePolicyForWorkspace,
  readServiceManagementFee,
  setServiceManagementFee,
} from "@/lib/owner-management/policies.server";
import { feePercentForOwnerShareBps } from "@/lib/owner-management/fee-percent";
import { serviceSetupPendingProblem } from "@/lib/managed-finance/unpolicied-service.server";

const WS = "ws-seattle";
const PLATFORM = "proplane-service-owner";
const OWNER = "owner-dana";
const admin = { role: "admin" as const, userId: "admin-1" };

/** The database clock `activate_managed_policy` stamps rows with. */
let dbClockIso = "2026-10-15T19:00:00Z";
const dbNow = () => new Date(dbClockIso);

/**
 * Mirrors `activate_managed_policy` (migrations 20261020170000 + 20261020200000): activate the draft and end the
 * version it replaces, atomically - unless the caller is the system, which only ever fills a gap.
 */
function activateRpc(args: Record<string, unknown>, f: OwnerFakeDb) {
  const rows = f.rows.managed_workspace_fee_policies!;
  const row = rows.find((r) => r.id === args.p_id);
  if (!row) return { status: "refused", reason: "not_found" };
  if (row.status !== "draft") return { status: "refused", reason: "not_draft" };
  // Migration 20261020200000: the automatic fee only fills a GAP, so a system activation refuses when the
  // workspace already has an accepted version - checked here, under this function's own row lock.
  if (args.p_actor_role === "system" && rows.some((r) => r.workspace_id === row.workspace_id && r.status === "active" && r.signed_at && r.id !== row.id)) {
    return { status: "refused", reason: "already_active" };
  }
  const utcDay = dbNow().toISOString().slice(0, 10);
  for (const other of rows) {
    if (other.workspace_id !== row.workspace_id || other.status !== "active") continue;
    const endsOn = utcDay > String(other.effective_from) ? utcDay : other.effective_from;
    Object.assign(other, { status: "ended", ends_on: endsOn, ended_at: dbNow().toISOString(), ended_by_role: "system" });
  }
  Object.assign(row, {
    status: "active", signed_at: dbNow().toISOString(), accepted_via: args.p_via,
    terms_sha256: args.p_hash, terms_snapshot: args.p_snapshot, attestation_note: args.p_note,
  });
  return { status: "active" };
}

function world(extra: Record<string, FakeRow[]> = {}) {
  return fakeOwnerDb(
    {
      portal_workspaces: [
        { id: WS, owner_user_id: PLATFORM, name: "Seattle Homes", is_service: true },
        { id: "ws-ownerless", owner_user_id: PLATFORM, name: "Ballard Row", is_service: true },
      ],
      platform_service_settings: [{ singleton: true, owner_user_id: PLATFORM }],
      account_link_invites: [{ id: "i1", workspace_id: WS, invitee_user_id: OWNER, status: "accepted", is_owner_of_record: true }],
      profiles: [{ id: OWNER, email: "dana@example.test" }],
      manager_property_records: [
        { id: "house-1", manager_user_id: "mgr-1", workspace_id: WS },
        { id: "house-2", manager_user_id: "mgr-1", workspace_id: "ws-ownerless" },
      ],
      managed_workspace_fee_policies: [],
      ...extra,
    },
    { rpc: { activate_managed_policy: activateRpc } },
  );
}

const say = (line: string) => console.log(line);
const pct = (row: FakeRow) => feePercentForOwnerShareBps(Number(row.owner_share_bps));

describe("evidence: the automatic PropLane management fee", () => {
  it("is put in place by a resident's own rent checkout - nothing is signed, nothing is paused", async () => {
    dbClockIso = "2026-10-15T19:00:00Z";
    const f = world();
    say("\n1. A PropLane Service workspace with no fee policy at all. A resident goes to pay rent on one of its houses.");
    const problem = await serviceSetupPendingProblem(f.db, ["house-1"], new Date("2026-10-15T12:00:00-07:00"));
    say(`   checkout guard answered: ${problem === null ? "no problem - the payment goes through" : JSON.stringify(problem)}`);
    expect(problem).toBeNull();

    const policies = f.rows.managed_workspace_fee_policies!;
    expect(policies).toHaveLength(1);
    const policy = policies[0]!;
    say(`   the workspace now holds: ${policy.status} · ${pct(policy)}% of rent · accepted_via ${policy.accepted_via}` +
      ` · note "${policy.attestation_note}" · effective_from ${policy.effective_from}`);
    say(`   signature trail: sent_at=${policy.sent_at ?? "null"} (nothing was ever sent for signature),` +
      ` signed_at=${policy.signed_at ? "stamped by the activation itself" : "null"}`);
    expect(policy).toMatchObject({ status: "active", accepted_via: "admin_attested", owner_share_bps: 9000, owner_user_id: OWNER });
    expect(policy.sent_at ?? null).toBeNull();
    expect(String(policy.attestation_note)).toBe("Automatic PropLane management fee");
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
  });

  it("changes the rate the moment an admin saves it, and leaves rent already taken on the version it was taken under", async () => {
    dbClockIso = "2026-10-15T19:00:00Z";
    const f = world();
    await ensureServiceFeePolicy(f.db, WS, admin, new Date("2026-10-15T12:00:00-07:00"));
    say("\n2. Admin > Service: the rate box is saved at 12% on Oct 15.");
    const changed = await setServiceManagementFee(f.db, admin, WS, 12, new Date("2026-10-15T12:05:00-07:00"));
    say(`   save answered: fee ${changed.feePercent}%, changed=${changed.changed}`);
    expect(changed).toMatchObject({ feePercent: 12, changed: true });

    const versions = (await listPoliciesForWorkspace(f.db, WS)).map((p) => ({
      status: p.status, percent: feePercentForOwnerShareBps(p.terms.ownerShareBps), from: p.effectiveFrom, endsOn: p.endsOn,
    }));
    say(`   the workspace's fee versions: ${JSON.stringify(versions)}`);
    expect([...versions].sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { status: "active", percent: 12, from: "2026-10-15", endsOn: null },
      { status: "ended", percent: 10, from: "2026-10-15", endsOn: "2026-10-15" },
    ]);
    say(`   what the admin screen reads back: ${JSON.stringify(await readServiceManagementFee(f.db, WS))}`);
    expect((await readServiceManagementFee(f.db, WS))?.feePercent).toBe(12);
  });

  it("settles a payment on the version in force the day it was taken", async () => {
    dbClockIso = "2026-10-01T19:00:00Z";
    const f = world();
    await ensureServiceFeePolicy(f.db, WS, admin, new Date("2026-10-01T12:00:00-07:00"));
    dbClockIso = "2026-10-15T19:00:00Z";
    await setServiceManagementFee(f.db, admin, WS, 12, new Date("2026-10-15T12:00:00-07:00"));

    say("\n3. An ACH debit taken on Oct 10 settles today (Oct 18). Which version does it settle on?");
    const onOct10 = await loadActivePolicyForWorkspace(f.db, WS, "2026-10-10");
    const onOct18 = await loadActivePolicyForWorkspace(f.db, WS, "2026-10-18");
    say(`   paid Oct 10 -> ${feePercentForOwnerShareBps(onOct10!.terms.ownerShareBps)}% (${onOct10!.status} version)`);
    say(`   paid Oct 18 -> ${feePercentForOwnerShareBps(onOct18!.terms.ownerShareBps)}% (${onOct18!.status} version)`);
    expect(feePercentForOwnerShareBps(onOct10!.terms.ownerShareBps)).toBe(10);
    expect(onOct10!.status).toBe("ended");
    expect(feePercentForOwnerShareBps(onOct18!.terms.ownerShareBps)).toBe(12);
    expect(onOct18!.status).toBe("active");
  });

  it("never overwrites a hand-authored draft, and flags a workspace whose fee cannot be set", async () => {
    dbClockIso = "2026-10-15T19:00:00Z";
    const f = world();
    await ensureServiceFeePolicy(f.db, WS, admin, new Date("2026-10-15T12:00:00-07:00"));
    f.rows.managed_workspace_fee_policies!.push({
      id: "draft-by-hand", workspace_id: WS, owner_user_id: OWNER, status: "draft", owner_share_bps: 8500,
      applies_to: "rent", leasing_fee_bps: 250, min_fee_cents: 0, reserve_target_cents: 0,
      repair_approval_threshold_cents: 25_000, effective_from: "2026-10-15", created_at: "2026-10-15",
    });
    say("\n4. An admin has a fee policy draft open in Admin > Managed finance (15% and a leasing fee). The rate box is saved at 12%:");
    await expect(setServiceManagementFee(f.db, admin, WS, 12)).rejects.toThrow(HAND_AUTHORED_DRAFT_MESSAGE);
    say(`   refused: "${HAND_AUTHORED_DRAFT_MESSAGE}"`);
    const draft = f.rows.managed_workspace_fee_policies!.find((p) => p.id === "draft-by-hand")!;
    say(`   the hand-authored draft is untouched: ${draft.status} · ${pct(draft)}% · leasing ${draft.leasing_fee_bps} bps`);
    expect(draft).toMatchObject({ status: "draft", owner_share_bps: 8500, leasing_fee_bps: 250 });

    say("\n5. A service workspace with no owner of record: the fee cannot be set, so the checkout still fails closed.");
    const problem = await serviceSetupPendingProblem(f.db, ["house-2"], new Date("2026-10-15T12:00:00-07:00"));
    say(`   checkout guard answered: ${JSON.stringify(problem)}`);
    expect(problem?.code).toBe("SERVICE_SETUP_PENDING");
    const flags = f.rows.owner_ledger_flags ?? [];
    say(`   admin attention item raised: ${JSON.stringify(flags.map((r) => ({ check: r.check_name, subject: r.subject, detail: r.detail })))}`);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ check_name: "fee_agreement_unsigned", subject: "ws-ownerless" });
    expect((flags[0]!.detail as { cause: string }).cause).toBe("no_owner");
    expect((flags[0]!.detail as { message: string }).message).not.toMatch(/sign/i);
  });

  it("stands aside when an admin recorded a rate of their own in the meantime, and leaves nothing behind", async () => {
    dbClockIso = "2026-10-15T19:00:00Z";
    const f = world();
    say("\n6. A resident's checkout drafts the automatic 10%. In the moment between reading \"no fee yet\" and");
    say("   activating it, an admin records 12% by hand in Admin > Managed finance:");
    const db = {
      ...f.db,
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "activate_managed_policy") {
          // The admin's own version lands first, between this module's read and its activation.
          f.rows.managed_workspace_fee_policies!.push({
            id: "by-the-admin", workspace_id: WS, owner_user_id: OWNER, status: "active", owner_share_bps: 8800,
            applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 0,
            repair_approval_threshold_cents: 25_000, effective_from: "2026-10-15", created_at: "2026-10-15",
            signed_at: "2026-10-15T19:00:00Z", accepted_via: "admin_attested",
            attestation_note: "Hand-authored rate agreed with the owner", terms_sha256: "a".repeat(64),
          });
        }
        return f.db.rpc(name, args);
      },
    } as typeof f.db;

    const problem = await serviceSetupPendingProblem(db, ["house-1"], new Date("2026-10-15T12:00:00-07:00"));
    say(`   checkout guard answered: ${problem === null ? "no problem - the payment goes through" : JSON.stringify(problem)}`);
    expect(problem).toBeNull();

    const versions = (await listPoliciesForWorkspace(f.db, WS)).map((p) =>
      `${p.status} ${feePercentForOwnerShareBps(p.terms.ownerShareBps)}%`);
    say(`   the rate in force: ${feePercentForOwnerShareBps((await loadActivePolicyForWorkspace(f.db, WS))!.terms.ownerShareBps)}% (the admin's)`);
    say(`   every fee version this workspace has: ${JSON.stringify(versions)} - the automatic draft took itself back out`);
    expect(versions).toEqual(["active 12%"]);
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
  });

  it("reads the rate by the Pacific day a resident is paying on, not the UTC one", async () => {
    dbClockIso = "2026-10-01T19:00:00Z";
    const f = world();
    await ensureServiceFeePolicy(f.db, WS, admin, new Date("2026-10-01T12:00:00-07:00"));
    // A retired version whose `ends_on` was stamped from the database's UTC clock, so it reads a day long.
    const row = f.rows.managed_workspace_fee_policies![0]!;
    Object.assign(row, { effective_from: "2026-10-01", ends_on: "2026-10-21", ended_at: null, status: "ended" });

    say("\n7. A resident pays at 18:00 Pacific on Oct 20 - which is already Oct 21 in UTC.");
    const problem = await serviceSetupPendingProblem(f.db, ["house-1"], new Date("2026-10-21T01:00:00Z"));
    say(`   checkout guard answered: ${problem === null ? "no problem - the payment goes through" : JSON.stringify(problem)}`);
    say(`   fee versions after the checkout: ${(await listPoliciesForWorkspace(f.db, WS)).length} (the version in force was found,` +
      " so nothing was drafted and no operator was paged)");
    expect(problem).toBeNull();
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
  });
});
