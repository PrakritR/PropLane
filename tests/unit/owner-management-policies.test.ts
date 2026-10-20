import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow, type OwnerFakeDb } from "../helpers/owner-fake-db";

const email = vi.hoisted(() => vi.fn(async () => ({ status: "sent" })));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: email }));
const text = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: text }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.test" }));

import {
  PolicyError,
  attestPolicy,
  createDraftPolicy,
  endPolicy,
  ensureServiceFeePolicy,
  HAND_AUTHORED_DRAFT_MESSAGE,
  setServiceManagementFee,
  listManagedWorkspacesForOwner,
  loadActivePolicyForWorkspace,
  loadPolicy,
  readServiceManagementFee,
  setOwnerPreferences,
  updateDraftPolicy,
} from "@/lib/owner-management/policies.server";
import { flagManagedFeeProblem } from "@/lib/owner-management/fee-flags.server";
import type { ManagedFeeTerms } from "@/lib/owner-management/fee-math";

const WS = "ws-1";
const PL = "pl-user";
const OWNER = "own-1";
const admin = { role: "admin" as const, userId: "admin-1" };
const terms: ManagedFeeTerms = { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 25_000 };
const input = { workspaceId: WS, ownerUserId: OWNER, terms, effectiveFrom: "2020-01-01" };

/** The `not null default` values migration 20261018270000 gives the two v3 columns. */
const POLICY_COLUMN_DEFAULTS = { reserve_target_cents: 0, repair_approval_threshold_cents: 25_000 };

/**
 * Mirrors `activate_managed_policy` (migration 20261020170000): end the workspace's active version and activate the
 * draft, atomically - and REFUSE unless the row's own live terms are still the ones `p_snapshot` was taken against.
 * The function writes `terms_sha256` / `terms_snapshot` from the caller but leaves the live `owner_share_bps` and
 * friends alone, and fee math reads those columns, so without this comparison an admin editing the draft between
 * the owner's load and this call activated the EDITED fee under her signature.
 */
function activateRpc(args: Record<string, unknown>, f: OwnerFakeDb) {
  const rows = f.rows.managed_workspace_fee_policies!;
  const row = rows.find((r) => r.id === args.p_id);
  if (!row) return { status: "refused", reason: "not_found" };
  if (row.status === "active") return { status: "exists" };
  if (row.status !== "draft") return { status: "refused", reason: "not_draft" };
  if (args.p_via === "owner_signature" && !row.sent_at) return { status: "refused", reason: "not_sent" };
  const snapshot = (args.p_snapshot ?? {}) as Record<string, unknown>;
  const same =
    String(snapshot.workspaceId) === String(row.workspace_id) &&
    String(snapshot.ownerUserId) === String(row.owner_user_id) &&
    String(snapshot.ownerShareBps) === String(row.owner_share_bps) &&
    String(snapshot.appliesTo) === String(row.applies_to) &&
    String(snapshot.leasingFeeBps) === String(row.leasing_fee_bps) &&
    String(snapshot.minFeeCents) === String(row.min_fee_cents) &&
    String(snapshot.effectiveFrom) === String(row.effective_from);
  if (!same) return { status: "refused", reason: "terms_changed" };
  // The v3 terms: compared when the snapshot names them, else allowed only on the column's own default - a
  // canonical-v2 snapshot (from code that has not deployed yet) never saw them, so it may only vouch for a row
  // that still carries the defaults a v2-era draft was created with.
  const v3 = [
    ["reserveTargetCents", "reserve_target_cents", POLICY_COLUMN_DEFAULTS.reserve_target_cents],
    ["repairApprovalThresholdCents", "repair_approval_threshold_cents", POLICY_COLUMN_DEFAULTS.repair_approval_threshold_cents],
  ] as const;
  for (const [key, column, columnDefault] of v3) {
    if (key in snapshot) {
      if (String(snapshot[key]) !== String(row[column])) return { status: "refused", reason: "terms_changed" };
    } else if (Number(row[column]) !== columnDefault) {
      return { status: "refused", reason: "terms_changed" };
    }
  }
  // `ends_on = greatest(current_date, effective_from)` in SQL. The row being activated started today, so its own
  // `effective_from` stands in for `current_date`: the version it replaces stops the day this one begins.
  for (const other of rows) {
    if (other.workspace_id !== row.workspace_id || other.status !== "active") continue;
    const endsOn = String(row.effective_from) > String(other.effective_from) ? row.effective_from : other.effective_from;
    Object.assign(other, { status: "ended", ends_on: endsOn });
  }
  Object.assign(row, { status: "active", signed_at: "2026-10-19T00:00:00Z", accepted_via: args.p_via, terms_sha256: args.p_hash, terms_snapshot: args.p_snapshot, attestation_note: args.p_note });
  return { status: "active" };
}

function seed(extra: Record<string, FakeRow[]> = {}, rpc: Record<string, (args: Record<string, unknown>, f: OwnerFakeDb) => unknown> = {}) {
  return fakeOwnerDb(
    {
      portal_workspaces: [{ id: WS, owner_user_id: PL, name: "Seattle Homes", is_service: true }],
      platform_service_settings: [{ singleton: true, owner_user_id: PL }],
      account_link_invites: [{ id: "i1", workspace_id: WS, invitee_user_id: OWNER, status: "accepted" }],
      profiles: [{ id: OWNER, email: "o@x.test", phone: "+12065550100", phone_verified_at: "2026-01-01" }],
      managed_workspace_fee_policies: [],
      ...extra,
    },
    { rpc: { activate_managed_policy: activateRpc, ...rpc } },
  );
}

beforeEach(() => {
  email.mockClear();
  text.mockClear();
});

describe("drafting", () => {
  it("drafts a policy for a person on the workspace team", async () => {
    const f = seed();
    const row = await createDraftPolicy(f.db, admin, input);
    expect(row).toMatchObject({ status: "draft", workspaceId: WS, ownerUserId: OWNER });
    expect(row.terms.ownerShareBps).toBe(9000);
  });
  it("refuses a person who is not on the team, and the PropLane manager themselves", async () => {
    const f = seed();
    await expect(createDraftPolicy(f.db, admin, { ...input, ownerUserId: "stranger" })).rejects.toMatchObject({ status: 422 });
    await expect(createDraftPolicy(f.db, admin, { ...input, ownerUserId: PL })).rejects.toMatchObject({ status: 422 });
  });
  it("refuses a missing workspace, bad terms, a future start and a second open draft", async () => {
    const f = seed();
    await expect(createDraftPolicy(f.db, admin, { ...input, workspaceId: "ghost" })).rejects.toMatchObject({ status: 404 });
    await expect(createDraftPolicy(f.db, admin, { ...input, terms: { ...terms, ownerShareBps: 4000 } })).rejects.toMatchObject({ status: 400 });
    await expect(createDraftPolicy(f.db, admin, { ...input, effectiveFrom: "2999-01-01" })).rejects.toMatchObject({ status: 400 });
    await createDraftPolicy(f.db, admin, input);
    await expect(createDraftPolicy(f.db, admin, input)).rejects.toMatchObject({ status: 409 });
  });
  it("editing a draft rewrites its terms and clears any legacy sent stamp", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    f.rows.managed_workspace_fee_policies![0]!.sent_at = "2026-10-18T20:00:00Z";
    const edited = await updateDraftPolicy(f.db, admin, d.id, { terms: { ...terms, ownerShareBps: 8500 } });
    expect(edited.sentAt).toBeNull();
    expect(edited.terms.ownerShareBps).toBe(8500);
  });
});

describe("the owner of record rule", () => {
  it("a client who owns an attached workspace IS its owner of record; the platform service owner never is", async () => {
    const client = "client-1";
    const f = seed({ portal_workspaces: [{ id: WS, owner_user_id: client, name: "1. Ambika", is_service: true }] });
    const row = await createDraftPolicy(f.db, admin, { ...input, ownerUserId: client });
    expect(row).toMatchObject({ status: "draft", ownerUserId: client });
    // The same person on a workspace the service owner owns: refused (it would pay PropLane its own owner share).
    const g = seed();
    await expect(createDraftPolicy(g.db, admin, { ...input, ownerUserId: PL })).rejects.toMatchObject({ status: 422 });
  });
});

describe("the automatic management fee", () => {
  const CLIENT = "client-1";
  const clientOwned = (extra: Record<string, FakeRow[]> = {}) =>
    seed({ portal_workspaces: [{ id: WS, owner_user_id: CLIENT, name: "1. Ambika", is_service: true }], ...extra });

  it("creates the 10% policy for a client-owned workspace, owner of record = the client, admin-attested, no signature", async () => {
    const f = clientOwned();
    const r = await ensureServiceFeePolicy(f.db, WS);
    expect(r.status).toBe("created");
    const policy = (r as { policy: Awaited<ReturnType<typeof loadPolicy>> & object }).policy;
    expect(policy).toMatchObject({ status: "active", ownerUserId: CLIENT, acceptedVia: "admin_attested" });
    expect(policy.terms).toEqual({ ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 25_000 });
    const call = f.rpcCalls.find((c) => c.name === "activate_managed_policy")!;
    expect(call.args).toMatchObject({ p_via: "admin_attested", p_note: "Automatic PropLane management fee", p_actor_role: "system" });
    expect(email).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("is idempotent: an active policy is left alone", async () => {
    const f = clientOwned();
    await ensureServiceFeePolicy(f.db, WS);
    const again = await ensureServiceFeePolicy(f.db, WS);
    expect(again.status).toBe("exists");
    expect(f.rpcCalls.filter((c) => c.name === "activate_managed_policy")).toHaveLength(1);
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
  });

  it("a service-owner-owned workspace uses its flagged owner-of-record member, and says no_owner without one", async () => {
    const none = seed();
    expect(await ensureServiceFeePolicy(none.db, WS)).toEqual({ status: "unavailable", reason: "no_owner" });
    expect(none.rows.managed_workspace_fee_policies).toHaveLength(0);
    const f = seed({ account_link_invites: [{ id: "i1", workspace_id: WS, invitee_user_id: OWNER, status: "accepted", is_owner_of_record: true }] });
    const r = await ensureServiceFeePolicy(f.db, WS);
    expect(r).toMatchObject({ status: "created", policy: { ownerUserId: OWNER } });
  });

  // Review fix, Oct 20: with no `platform_service_settings` row there is no way to tell a client-owned workspace
  // from PropLane's own, and naming PropLane as owner of record would pay PropLane its own owner share.
  it("fails closed when the platform service owner is not configured, rather than naming the workspace owner", async () => {
    const f = clientOwned({ platform_service_settings: [] });
    expect(await ensureServiceFeePolicy(f.db, WS)).toEqual({ status: "unavailable", reason: "no_owner" });
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(0);
  });

  it("an unreadable settings or membership read is `owner_unreadable`, never `no_owner`", async () => {
    const f = clientOwned();
    const broken = fakeOwnerDb(
      { portal_workspaces: [{ id: WS, owner_user_id: CLIENT, name: "1. Ambika", is_service: true }], managed_workspace_fee_policies: [] },
      { broken: ["platform_service_settings"], rpc: { activate_managed_policy: activateRpc } },
    );
    // A table that is simply not there yet reads as "no row" (no_owner); a real read failure is its own reason.
    expect((await ensureServiceFeePolicy(broken.db, WS)).status).toBe("unavailable");
    void f;
  });

  it("skips a workspace that is not a service workspace, and never throws on an unreadable one", async () => {
    const f = seed({ portal_workspaces: [{ id: WS, owner_user_id: CLIENT, name: "Self serve", is_service: false }] });
    expect((await ensureServiceFeePolicy(f.db, WS)).status).toBe("not_service");
    const g = fakeOwnerDb({ portal_workspaces: [] }, { broken: ["managed_workspace_fee_policies"] });
    expect((await ensureServiceFeePolicy(g.db, WS)).status).toBe("not_service");
    const h = clientOwned();
    const broken = { ...h.db, from: () => { throw new Error("boom"); } } as never;
    expect((await ensureServiceFeePolicy(broken, WS)).status).toBe("unavailable");
  });

  // Review fix, Oct 20: rent must flow. An admin's open draft is a human still deciding, not a reason a resident
  // cannot pay: the default is activated beside it and the draft is left exactly where it is.
  it("activates the default beside an admin's draft rather than holding rent up, and leaves the draft alone", async () => {
    const draft = { id: "old", workspace_id: WS, owner_user_id: CLIENT, status: "draft", owner_share_bps: 8000, applies_to: "rent", leasing_fee_bps: 5000, min_fee_cents: 20_000, reserve_target_cents: 0, repair_approval_threshold_cents: 25_000, effective_from: "2026-01-01", created_at: "2026-01-01" };
    const f = clientOwned({ managed_workspace_fee_policies: [draft] });
    expect((await ensureServiceFeePolicy(f.db, WS)).status).toBe("created");
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(9000);
    expect(await loadPolicy(f.db, "old")).toMatchObject({ status: "draft", terms: { ownerShareBps: 8000, leasingFeeBps: 5000, minFeeCents: 20_000 } });
    expect(f.rows.owner_ledger_flags ?? []).toHaveLength(0);
    // Recording the admin's draft later ends the default through the ordinary activation path.
    await attestPolicy(f.db, admin, "old", "Signed PDF in the owners drive");
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(8000);
    expect(f.rows.managed_workspace_fee_policies!.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("creates the 10% default when the workspace has no policy in force", async () => {
    const f = clientOwned();
    expect((await ensureServiceFeePolicy(f.db, WS)).status).toBe("created");
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(9000);
  });

  // Every failure reaches an operator in Admin > Finances > Flags, with the cause - never only a console line.
  it("raises the attention item with the cause on every failure, not just a log line", async () => {
    const none = seed();
    expect(await ensureServiceFeePolicy(none.db, WS)).toEqual({ status: "unavailable", reason: "no_owner" });
    expect((none.rows.owner_ledger_flags ?? [])[0]).toMatchObject({ check_name: "fee_agreement_unsigned", subject: WS });
    expect(((none.rows.owner_ledger_flags ?? [])[0]!.detail as { cause: string }).cause).toBe("no_owner");

    // An unreadable membership read is its own cause: an operator is never told to name an owner for a blinked read.
    const unreadable = fakeOwnerDb(
      {
        portal_workspaces: [{ id: WS, owner_user_id: PL, name: "PropLane Seattle", is_service: true }],
        platform_service_settings: [{ singleton: true, owner_user_id: PL }],
        managed_workspace_fee_policies: [],
      },
      { broken: ["account_link_invites"], rpc: { activate_managed_policy: activateRpc } },
    );
    expect(await ensureServiceFeePolicy(unreadable.db, WS)).toEqual({ status: "unavailable", reason: "owner_unreadable" });
    const flag = (unreadable.rows.owner_ledger_flags ?? [])[0];
    expect(flag).toMatchObject({ check_name: "fee_agreement_unsigned", subject: WS });
    expect((flag!.detail as { cause: string; message: string }).cause).toBe("owner_unreadable");
    expect((flag!.detail as { message: string }).message).not.toContain("name its owner of record");
  });

  // Review fix, Oct 20: the day's attention item is UPDATED, so the last writer's context lands on it instead of
  // being dropped as a duplicate - `fee_unavailable` from the ensure call, then where the refusal was actually felt.
  it("keeps one attention item a day and lets the money path name where the refusal was felt", async () => {
    const f = seed();
    await ensureServiceFeePolicy(f.db, WS);
    expect(f.rows.owner_ledger_flags).toHaveLength(1);
    expect((f.rows.owner_ledger_flags![0]!.detail as { reason: string }).reason).toBe("fee_unavailable");
    await flagManagedFeeProblem(f.db, { workspaceId: WS, workspaceName: "PropLane Seattle", cause: "no_owner", reason: "checkout_refused" });
    expect(f.rows.owner_ledger_flags).toHaveLength(1);
    expect((f.rows.owner_ledger_flags![0]!.detail as { reason: string }).reason).toBe("checkout_refused");
  });

  // Review fix, Oct 20: a rate change is immediate. `targetMonthlyFeeCents` prices against the month's cumulative base,
  // and a settlement records its own split, so a new rate reaches payments settled from this moment on and no further.
  it("an admin fee change activates a new version now and ends the previous one, one active at a time", async () => {
    const f = clientOwned();
    const now = new Date("2026-10-20T19:00:00Z");
    const first = (await ensureServiceFeePolicy(f.db, WS, admin, now)) as { policy: { id: string } };
    const change = await setServiceManagementFee(f.db, admin, WS, 15, now);
    expect(change).toMatchObject({ feePercent: 15, changed: true });
    expect(change.policyId).not.toBe(first.policy.id);

    const inForce = await loadActivePolicyForWorkspace(f.db, WS);
    expect(inForce).toMatchObject({ id: change.policyId, status: "active", acceptedVia: "admin_attested", ownerUserId: CLIENT });
    expect(inForce?.terms.ownerShareBps).toBe(8500);
    expect(inForce?.effectiveFrom).toBe("2026-10-20");
    expect((await loadPolicy(f.db, first.policy.id))?.status).toBe("ended");
    expect(f.rows.managed_workspace_fee_policies!.filter((r) => r.status === "active")).toHaveLength(1);
    expect(f.rows.managed_workspace_fee_policies!.filter((r) => r.status === "draft")).toHaveLength(0);
    expect(await readServiceManagementFee(f.db, WS)).toMatchObject({ feePercent: 15 });
  });

  // Review fix, Oct 20: a dated read used to answer "not managed" for any payment older than the version in force,
  // and `resolveManagedForProperties` turns that into a manager hold - the owner's 90% never allocated at all. An ACH
  // debit is days old when it settles, so a rate change would strand every payment in flight.
  it("a payment settles on the version in force the day it was taken, not the one in force now", async () => {
    const f = clientOwned();
    const started = new Date("2026-10-10T19:00:00Z");
    const first = (await ensureServiceFeePolicy(f.db, WS, admin, started)) as { policy: { id: string } };
    const changed = new Date("2026-10-20T19:00:00Z");
    await setServiceManagementFee(f.db, admin, WS, 15, changed);

    // Today: the new rate. A payment taken before the change: the rate it was taken under, never null.
    expect((await loadActivePolicyForWorkspace(f.db, WS, "2026-10-20"))?.terms.ownerShareBps).toBe(8500);
    const earlier = await loadActivePolicyForWorkspace(f.db, WS, "2026-10-15");
    expect(earlier).toMatchObject({ id: first.policy.id, status: "ended" });
    expect(earlier?.terms.ownerShareBps).toBe(9000);
    // Before any policy existed the workspace really was not managed.
    expect(await loadActivePolicyForWorkspace(f.db, WS, "2026-10-01")).toBeNull();
    // An undated read is still just the version in force now.
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(8500);
  });

  it("the same rate again changes nothing, but setting the FIRST policy is a change", async () => {
    const f = clientOwned();
    const now = new Date("2026-10-20T19:00:00Z");
    // No policy yet: saving the default rate still put one in force today.
    const firstSave = await setServiceManagementFee(f.db, admin, WS, 10, now);
    expect(firstSave).toMatchObject({ feePercent: 10, changed: true });
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(9000);
    // Saving it again moves nothing.
    expect(await setServiceManagementFee(f.db, admin, WS, 10, now)).toEqual({ feePercent: 10, changed: false, policyId: firstSave.policyId });
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(1);
  });

  // Review fix, Oct 20: `openDraftForWorkspace` returns ANY draft, so Admin > Service used to overwrite or end a draft
  // hand-authored in Admin > Managed finance, silently losing its leasing fee / minimum / reserve.
  it("refuses to touch a draft Admin > Service did not author", async () => {
    const f = clientOwned();
    const now = new Date("2026-10-20T19:00:00Z");
    await ensureServiceFeePolicy(f.db, WS, admin, now);
    const byHand = await createDraftPolicy(f.db, admin, { workspaceId: WS, ownerUserId: CLIENT, terms: { ...terms, leasingFeeBps: 5000, minFeeCents: 20_000 }, effectiveFrom: "2026-10-01" }, now);
    await expect(setServiceManagementFee(f.db, admin, WS, 15, now)).rejects.toMatchObject({ status: 409, message: HAND_AUTHORED_DRAFT_MESSAGE });
    const untouched = await loadPolicy(f.db, byHand.id);
    expect(untouched).toMatchObject({ status: "draft", effectiveFrom: "2026-10-01" });
    expect(untouched?.terms).toMatchObject({ leasingFeeBps: 5000, minFeeCents: 20_000 });
    // The rate in force is untouched too, and the draft is still the admin's to record or end.
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(9000);
  });

  it("the range is one answer: 0 and 30 are the ends, anything else is refused before a row is written", async () => {
    const f = clientOwned();
    const now = new Date("2026-10-20T19:00:00Z");
    await ensureServiceFeePolicy(f.db, WS, admin, now);
    expect(await setServiceManagementFee(f.db, admin, WS, 0, now)).toMatchObject({ feePercent: 0, changed: true });
    expect(await setServiceManagementFee(f.db, admin, WS, "30", now)).toMatchObject({ feePercent: 30, changed: true });
    const before = f.rows.managed_workspace_fee_policies!.length;
    for (const bad of [31, -1, "abc", 12.345, null]) {
      await expect(setServiceManagementFee(f.db, admin, WS, bad, now)).rejects.toMatchObject({ status: 400 });
    }
    expect(f.rows.managed_workspace_fee_policies).toHaveLength(before);
  });
});

describe("activating a draft (nothing is ever signed)", () => {
  // Review fix, Oct 20: the fee agreement signature is gone from the product. A fee policy is PropLane's own rate,
  // recorded by an admin or created automatically for a service workspace. The activation guard below is the same
  // one the signature used to run through, so it is exercised on the path that survives.
  it("an admin records a draft and the workspace becomes managed", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    const row = await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    expect(row).toMatchObject({ status: "active", acceptedVia: "admin_attested" });
    expect(row.termsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toMatchObject({ id: d.id });
    expect(email).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  // Review fix, Oct 20. `attestPolicy` compares the row it loads, then calls the function. The window between the
  // two was unguarded, so an edit landing inside it activated terms the admin never read.
  it("an edit landing between the load and the activate refuses, and nothing is activated", async () => {
    let edited = false;
    const f = seed({}, {
      activate_managed_policy: (args, ff) => {
        if (!edited) {
          edited = true;
          const row = ff.rows.managed_workspace_fee_policies!.find((r) => r.id === args.p_id)!;
          row.owner_share_bps = 5_000;
        }
        return activateRpc(args, ff);
      },
    });
    const d = await createDraftPolicy(f.db, admin, input);
    await expect(attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive")).rejects.toMatchObject({ status: 409 });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    expect(f.rows.managed_workspace_fee_policies![0]!.status).toBe("draft");
    expect(f.rows.managed_workspace_fee_policies![0]!.signed_at ?? null).toBeNull();
    // Reloading shows the new terms, and recording THOSE works.
    const row = await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    expect(row).toMatchObject({ status: "active" });
    expect(row.terms.ownerShareBps).toBe(5_000);
  });

  // Canonical v3 brought the repair threshold and the reserve inside the hash. The threshold decides whether a
  // vendor bill posts against the owner WITHOUT asking her, so a change in that window must refuse like any other.
  it("the repair threshold and the reserve are inside the activation hash too", async () => {
    for (const edit of [{ repair_approval_threshold_cents: 500_000 }, { reserve_target_cents: 250_000 }]) {
      let edited = false;
      const f = seed({}, {
        activate_managed_policy: (args, ff) => {
          if (!edited) {
            edited = true;
            Object.assign(ff.rows.managed_workspace_fee_policies!.find((r) => r.id === args.p_id)!, edit);
          }
          return activateRpc(args, ff);
        },
      });
      const d = await createDraftPolicy(f.db, admin, input);
      await expect(attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive")).rejects.toMatchObject({ status: 409 });
      expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
      expect((await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive")).status).toBe("active");
    }
  });

  /** A canonical-v2 snapshot: what code that has not deployed yet still builds. */
  const v2Snapshot = (policy: { workspaceId: string; ownerUserId: string; terms: ManagedFeeTerms; effectiveFrom: string }) => ({
    v: 2,
    workspaceId: policy.workspaceId,
    ownerUserId: policy.ownerUserId,
    ownerShareBps: policy.terms.ownerShareBps,
    appliesTo: policy.terms.appliesTo,
    leasingFeeBps: policy.terms.leasingFeeBps,
    minFeeCents: policy.terms.minFeeCents,
    effectiveFrom: policy.effectiveFrom,
  });

  // Review fix, Oct 20. This repo applies the migration BEFORE the code on each rung, so between the v3 guard
  // landing and the Vercel build there is a window where the running code still builds a v2 snapshot. Comparing
  // the two new columns unconditionally made every activation in that window 409, which would freeze a managed
  // workspace during the climb itself.
  it("accepts a v2 snapshot while the row still carries the v3 defaults", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    const row = f.rows.managed_workspace_fee_policies![0]!;
    expect([row.reserve_target_cents, row.repair_approval_threshold_cents]).toEqual([0, 25_000]);
    expect(activateRpc(
      { p_id: d.id, p_via: "admin_attested", p_snapshot: v2Snapshot(d), p_hash: "h" },
      f,
    )).toMatchObject({ status: "active" });
  });

  // It is a tolerance, not a hole: a term the snapshot never carried cannot be vouched for once it was SET.
  it("refuses a v2 snapshot once either v3 term was moved off its default", async () => {
    for (const edit of [{ reserve_target_cents: 250_000 }, { repair_approval_threshold_cents: 500_000 }]) {
      const f = seed();
      const d = await createDraftPolicy(f.db, admin, input);
      Object.assign(f.rows.managed_workspace_fee_policies![0]!, edit);
      expect(activateRpc(
        { p_id: d.id, p_via: "admin_attested", p_snapshot: v2Snapshot(d), p_hash: "h" },
        f,
      )).toMatchObject({ reason: "terms_changed" });
    }
  });

  it("a v3 snapshot is still compared on both new terms, default or not", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, { ...input, terms: { ...terms, repairApprovalThresholdCents: 400_000 } });
    expect(await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive")).toMatchObject({ status: "active" });
    const g = seed();
    const e = await createDraftPolicy(g.db, admin, input);
    expect(activateRpc(
      { p_id: e.id, p_via: "admin_attested", p_hash: "h", p_snapshot: { ...v2Snapshot(e), reserveTargetCents: 99, repairApprovalThresholdCents: 25_000 } },
      g,
    )).toMatchObject({ reason: "terms_changed" });
  });

  it("the SQL still refuses an owner signature on a draft that was never sent", () => {
    const f = seed();
    expect(activateRpc({ p_id: "nope", p_via: "owner_signature", p_snapshot: {} }, f)).toMatchObject({ reason: "not_found" });
  });

  it("is idempotent, and refuses once the owner of record left the team", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    expect((await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive")).status).toBe("active");
    const g = seed();
    const e = await createDraftPolicy(g.db, admin, input);
    g.rows.account_link_invites = [];
    await expect(attestPolicy(g.db, admin, e.id, "Signed PDF in the owners drive")).rejects.toMatchObject({ status: 422 });
  });
});

describe("attesting, versions, ending", () => {
  it("an admin can record an offline signed contract, with a note", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await expect(attestPolicy(f.db, admin, d.id, "short")).rejects.toMatchObject({ status: 400 });
    const row = await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    expect(row).toMatchObject({ status: "active", acceptedVia: "admin_attested" });
  });
  it("a new accepted version ends the previous one in the same step", async () => {
    const f = seed();
    const first = await createDraftPolicy(f.db, admin, input);
    await attestPolicy(f.db, admin, first.id, "Signed PDF in the owners drive");
    const second = await createDraftPolicy(f.db, admin, { ...input, terms: { ...terms, ownerShareBps: 8500 } });
    await attestPolicy(f.db, admin, second.id, "Amendment signed Oct 30");
    const active = await loadActivePolicyForWorkspace(f.db, WS);
    expect(active?.id).toBe(second.id);
    expect(active?.terms.ownerShareBps).toBe(8500);
    expect(f.rows.managed_workspace_fee_policies!.filter((r) => r.status === "active")).toHaveLength(1);
  });
  it("ending makes the workspace unmanaged and a ended policy stays ended", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    const ended = await endPolicy(f.db, admin, d.id, new Date("2026-12-05T18:00:00Z"));
    expect(ended).toMatchObject({ status: "ended", endsOn: "2026-12-05" });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    expect((await endPolicy(f.db, admin, d.id)).status).toBe("ended");
  });
  it("a read that fails is an error, never 'not managed'", async () => {
    const f = fakeOwnerDb({}, { broken: [] });
    const failing = { data: null, error: { code: "XX000" } };
    const chain: Record<string, unknown> = {};
    for (const key of ["select", "eq", "in", "not", "order", "limit"]) chain[key] = () => chain;
    chain.maybeSingle = async () => failing;
    chain.then = (resolve: (r: unknown) => void) => resolve(failing);
    f.db = { from: () => chain } as never;
    await expect(loadActivePolicyForWorkspace(f.db, WS)).rejects.toBeInstanceOf(PolicyError);
  });
  it("a database without the table is simply not managed", async () => {
    const f = fakeOwnerDb({}, { broken: ["managed_workspace_fee_policies"] });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    expect(await listManagedWorkspacesForOwner(f.db, OWNER)).toEqual([]);
  });
});

describe("the owner's own preferences", () => {
  it("can change the repair amount and reserve after signing, within range, and nobody else can", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    const row = await setOwnerPreferences(f.db, OWNER, d.id, { repairApprovalThresholdCents: 50_000, reserveTargetCents: 100_000 });
    expect(row.terms).toMatchObject({ repairApprovalThresholdCents: 50_000, reserveTargetCents: 100_000 });
    await expect(setOwnerPreferences(f.db, OWNER, d.id, { repairApprovalThresholdCents: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(setOwnerPreferences(f.db, "intruder", d.id, { repairApprovalThresholdCents: 1 })).rejects.toMatchObject({ status: 404 });
  });
  it("lists the workspaces a person is the owner of record of", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await attestPolicy(f.db, admin, d.id, "Signed PDF in the owners drive");
    const list = await listManagedWorkspacesForOwner(f.db, OWNER);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ workspaceId: WS, status: "active", workspaceName: "Seattle Homes" });
    expect(await listManagedWorkspacesForOwner(f.db, "someone-else")).toEqual([]);
  });
});

describe("the SQL mirror: the activation terms guard (migration 20261020170000)", () => {
  const sql = readFileSync("supabase/migrations/20261020170000_managed_policy_guard_v2_snapshot_tolerance.sql", "utf8");

  it("replaces the function on the same signature and keeps the grant fail-closed", () => {
    expect(sql).toContain("create or replace function public.activate_managed_policy(");
    expect(sql).toContain("p_id uuid, p_via text, p_note text, p_hash text, p_snapshot jsonb, p_actor_role text");
    expect(sql).toContain("revoke all on function public.activate_managed_policy(uuid, text, text, text, jsonb, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.activate_managed_policy(uuid, text, text, text, jsonb, text) to service_role;");
  });

  it("compares every fee term the owner's hash is taken over, under the row lock", () => {
    // The comparison has to come after `for update`, or it is reading a row another transaction may still change.
    const lockIdx = sql.indexOf("for update");
    const compareIdx = sql.indexOf("'terms_changed'");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(compareIdx).toBeGreaterThan(lockIdx);
    for (const key of [
      "workspaceId", "ownerUserId", "ownerShareBps", "appliesTo", "leasingFeeBps", "minFeeCents",
      "reserveTargetCents", "repairApprovalThresholdCents", "effectiveFrom",
    ]) {
      expect(sql).toContain(`p_snapshot->>'${key}'`);
    }
    // The two v3 terms are compared only when the snapshot names them, and otherwise only on the column default,
    // so the migration can land before the code that builds a v3 snapshot.
    expect(sql).toContain("if p_snapshot ? 'reserveTargetCents' then");
    expect(sql).toContain("if p_snapshot ? 'repairApprovalThresholdCents' then");
    expect(sql).toContain("elsif v_pol.reserve_target_cents is distinct from c_reserve_default then");
    expect(sql).toContain("elsif v_pol.repair_approval_threshold_cents is distinct from c_threshold_default then");
    expect(sql).toContain("c_reserve_default constant integer := 0;");
    expect(sql).toContain("c_threshold_default constant integer := 25000;");
    // Compared as TEXT, so a malformed snapshot refuses instead of raising a cast error.
    expect(sql).toContain("v_pol.owner_share_bps::text");
    expect(sql).toContain("to_char(v_pol.effective_from, 'YYYY-MM-DD')");
  });

  it("refuses an owner signature on a draft that was never sent", () => {
    expect(sql).toContain("if p_via = 'owner_signature' and v_pol.sent_at is null then");
    expect(sql).toContain("'not_sent'");
  });
});

describe("the SQL mirror: the atomic phone-code start (migration 20261020160000)", () => {
  const sql = readFileSync("supabase/migrations/20261020160000_phone_otp_start_caps_from_app.sql", "utf8");

  it("takes a per-phone lock before it counts anything", () => {
    const lockIdx = sql.indexOf("pg_advisory_xact_lock(hashtextextended('phone-otp:' || p_phone_key, 0))");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(sql.indexOf("select count(*) from public.phone_otp_challenges")).toBeGreaterThan(lockIdx);
  });

  it("takes every cap from the caller, and retires before it inserts", () => {
    // No second copy of the numbers: `SHARED_LINE_OTP_RULES` is the one place they are written.
    expect(sql).toContain("and purpose = p_purpose and created_at > v_now - interval '1 hour') >= p_max_per_purpose");
    expect(sql).toContain("and created_at > v_now - interval '1 hour') >= p_max_per_phone");
    expect(sql).toContain("public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= p_max_failed");
    expect(sql).not.toMatch(/>= *(?:3|8|10)\b/);
    // A missing or nonsensical cap refuses rather than meaning "no cap".
    expect(sql).toContain("p_max_per_purpose is null or p_max_per_purpose < 1");
    const retireIdx = sql.indexOf("set consumed_at = v_now");
    const insertIdx = sql.indexOf("insert into public.phone_otp_challenges");
    expect(retireIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(retireIdx);
    // The retire is scoped to this phone + purpose + SUBJECT: a code for one link never retires another's.
    expect(sql).toContain("subject_id is not distinct from p_subject");
  });

  it("is service-role only", () => {
    expect(sql).toContain("revoke all on function public.phone_otp_start(uuid, text, text, text, text, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.phone_otp_start(uuid, text, text, text, text, integer, integer, integer, integer, timestamptz) to service_role;");
    // The old signature goes, so two functions cannot disagree about the caps.
    expect(sql).toContain("drop function if exists public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz);");
  });
});

// Review fix, Oct 20: an ACH debit is days old when it settles, so a rate change used to strand every payment in
// flight - the resolver answered "not managed" and the capture fell to a manager hold. The resolver now answers with
// the version in force that day, and the database function has to accept that version even though it has ended.
describe("the SQL mirror: a capture settles on the version in force (migration 20261020190000)", () => {
  const sql = readFileSync("supabase/migrations/20261020190000_managed_capture_settles_on_version_in_force.sql", "utf8");

  it("replaces the function on the same signature and keeps the grant fail-closed", () => {
    expect(sql).toContain("create or replace function public.credit_managed_capture(");
    expect(sql).toContain("p_policy uuid, p_workspace uuid, p_key text, p_pi text, p_stripe_charge text, p_month text, p_available_on timestamptz,");
    expect(sql).toContain("revoke all on function public.credit_managed_capture(uuid, uuid, text, text, text, text, timestamptz, bigint, bigint, bigint, jsonb) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.credit_managed_capture(uuid, uuid, text, text, text, text, timestamptz, bigint, bigint, bigint, jsonb) to service_role;");
  });

  it("accepts an ended version only for rows paid inside its own window, in Pacific days", () => {
    expect(sql).toContain("v_pol.status not in ('active', 'ended')");
    expect(sql).toContain("if v_pol.status = 'ended' then");
    expect(sql).toContain("if v_pol.ends_on is null then");
    expect(sql).toContain("at time zone 'America/Los_Angeles')::date < v_pol.effective_from");
    expect(sql).toContain("at time zone 'America/Los_Angeles')::date >= v_pol.ends_on");
  });

  it("keeps every other guard the capture already had", () => {
    for (const guard of [
      "v_pol.workspace_id is distinct from p_workspace",
      "v_pol.signed_at is null",
      "'conflict', 'cum_base'",
      "'leasing_over_policy'",
      "'fee_over_policy'",
      "'split_mismatch'",
      "'bad_gross'",
    ]) {
      expect(sql).toContain(guard);
    }
  });
});
