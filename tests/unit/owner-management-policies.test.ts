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
  setServiceManagementFee,
  listManagedWorkspacesForOwner,
  loadActivePolicyForWorkspace,
  loadPolicy,
  sendPolicyForSignature,
  setOwnerPreferences,
  policyTermsHash,
  signPolicy,
  updateDraftPolicy,
} from "@/lib/owner-management/policies.server";
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
  for (const other of rows) if (other.workspace_id === row.workspace_id && other.status === "active") other.status = "ended";
  Object.assign(row, { status: "active", signed_at: "2026-10-19T00:00:00Z", accepted_via: args.p_via, terms_sha256: args.p_hash, terms_snapshot: args.p_snapshot });
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
  it("editing a draft clears the send so the owner never signs terms they were not shown", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    const edited = await updateDraftPolicy(f.db, admin, d.id, { terms: { ...terms, ownerShareBps: 8500 } });
    expect(edited.sentAt).toBeNull();
    await expect(signPolicy(f.db, OWNER, d.id, policyTermsHash(edited))).rejects.toMatchObject({ status: 409 });
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
    expect((await ensureServiceFeePolicy(none.db, WS)).status).toBe("no_owner");
    expect(none.rows.managed_workspace_fee_policies).toHaveLength(0);
    const f = seed({ account_link_invites: [{ id: "i1", workspace_id: WS, invitee_user_id: OWNER, status: "accepted", is_owner_of_record: true }] });
    const r = await ensureServiceFeePolicy(f.db, WS);
    expect(r).toMatchObject({ status: "created", policy: { ownerUserId: OWNER } });
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

  it("replaces a stale unsent draft rather than leaving it signable", async () => {
    const f = clientOwned({ managed_workspace_fee_policies: [{ id: "old", workspace_id: WS, owner_user_id: CLIENT, status: "draft", owner_share_bps: 8000, applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 0, repair_approval_threshold_cents: 25_000, effective_from: "2026-01-01", sent_at: "2026-01-02T00:00:00Z" }] });
    expect((await ensureServiceFeePolicy(f.db, WS)).status).toBe("created");
    expect((await loadPolicy(f.db, "old"))?.status).toBe("ended");
    expect((await loadActivePolicyForWorkspace(f.db, WS))?.terms.ownerShareBps).toBe(9000);
  });

  it("the admin fee change versions the policy: new rate active, the old one ended, one active at a time", async () => {
    const f = clientOwned();
    const first = (await ensureServiceFeePolicy(f.db, WS)) as { policy: { id: string } };
    const next = await setServiceManagementFee(f.db, admin, WS, 15);
    expect(next).toMatchObject({ status: "active", ownerUserId: CLIENT, acceptedVia: "admin_attested" });
    expect(next.terms.ownerShareBps).toBe(8500);
    expect(next.id).not.toBe(first.policy.id);
    expect((await loadPolicy(f.db, first.policy.id))?.status).toBe("ended");
    expect(f.rows.managed_workspace_fee_policies!.filter((r) => r.status === "active")).toHaveLength(1);
    // Same rate again: nothing new.
    expect((await setServiceManagementFee(f.db, admin, WS, 15)).id).toBe(next.id);
    // 0% and 30% are the ends of the range; 31% and nonsense are refused before anything is written.
    expect((await setServiceManagementFee(f.db, admin, WS, 0)).terms.ownerShareBps).toBe(10_000);
    expect((await setServiceManagementFee(f.db, admin, WS, "30")).terms.ownerShareBps).toBe(7000);
    for (const bad of [31, -1, "abc", 12.345, null]) {
      await expect(setServiceManagementFee(f.db, admin, WS, bad)).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe("sending and signing", () => {
  async function sent() {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    return { f, id: d.id, hash: policyTermsHash(d) };
  }
  it("emails and texts the owner a sign-in link", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    const r = await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    expect(r.emailed).toBe(true);
    expect(r.texted).toBe(true);
    expect(JSON.stringify(text.mock.calls[0])).toContain("/auth/sign-in?next=");
    expect((text.mock.calls[0] as unknown[])[1]).toMatchObject({ role: "manager", basis: { kind: "manager_notice", topic: "fee_policy" } });
  });
  it("does not resend inside the hour", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    await expect(sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:30:00Z"))).rejects.toMatchObject({ status: 429 });
  });
  it("only the named owner can sign, and it makes the workspace managed", async () => {
    const { f, id, hash } = await sent();
    await expect(signPolicy(f.db, "intruder", id, hash)).rejects.toMatchObject({ status: 404 });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    const signed = await signPolicy(f.db, OWNER, id, hash);
    expect(signed).toMatchObject({ status: "active", acceptedVia: "owner_signature" });
    expect(signed.termsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toMatchObject({ id });
  });
  // Review fix, Oct 20. `signPolicy` compares the presented hash against the row it loads, then calls the function.
  // The window between the two was unguarded, so an admin edit landing inside it activated a fee the owner never
  // saw - with a stored snapshot that said otherwise, and billing reading the live columns.
  it("an admin edit landing between the owner's load and the activate refuses, and nothing is activated", async () => {
    let edited = false;
    const f = seed({}, {
      // The edit lands in the window: after signPolicy read the row, before the function runs.
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
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    await expect(signPolicy(f.db, OWNER, d.id, policyTermsHash(d))).rejects.toMatchObject({ status: 409 });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    expect(f.rows.managed_workspace_fee_policies![0]!.status).toBe("draft");
    expect(f.rows.managed_workspace_fee_policies![0]!.signed_at ?? null).toBeNull();
    // Reloading shows her the new terms, and signing THOSE works.
    const fresh = await loadPolicy(f.db, d.id);
    const signed = await signPolicy(f.db, OWNER, d.id, policyTermsHash(fresh!));
    expect(signed).toMatchObject({ status: "active" });
    expect(signed.terms.ownerShareBps).toBe(5_000);
  });

  // Review fix, Oct 20: canonical v3 brought the repair threshold and the reserve inside the signature. The
  // threshold is what decides whether a vendor bill is posted against the owner WITHOUT asking her, so an admin
  // raising it in the window between her page's load and her signature must refuse like any other term change.
  it("an admin raising the no-ask repair threshold in that window refuses too", async () => {
    let edited = false;
    const f = seed({}, {
      activate_managed_policy: (args, ff) => {
        if (!edited) {
          edited = true;
          const row = ff.rows.managed_workspace_fee_policies!.find((r) => r.id === args.p_id)!;
          row.repair_approval_threshold_cents = 500_000;
        }
        return activateRpc(args, ff);
      },
    });
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    await expect(signPolicy(f.db, OWNER, d.id, policyTermsHash(d))).rejects.toMatchObject({ status: 409 });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    // Reloading shows her the raised threshold, and signing THAT works.
    const fresh = await loadPolicy(f.db, d.id);
    expect((await signPolicy(f.db, OWNER, d.id, policyTermsHash(fresh!))).terms.repairApprovalThresholdCents).toBe(500_000);
  });

  it("the reserve target is inside the signature as well", async () => {
    let edited = false;
    const f = seed({}, {
      activate_managed_policy: (args, ff) => {
        if (!edited) {
          edited = true;
          const row = ff.rows.managed_workspace_fee_policies!.find((r) => r.id === args.p_id)!;
          row.reserve_target_cents = 250_000;
        }
        return activateRpc(args, ff);
      },
    });
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    await expect(signPolicy(f.db, OWNER, d.id, policyTermsHash(d))).rejects.toMatchObject({ status: 409 });
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
  // the two new columns unconditionally made every signature in that window 409 "This agreement changed", and
  // reloading could not help - which would freeze a managed workspace mid-signing during the climb itself.
  it("accepts a v2 snapshot while the row still carries the v3 defaults", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    const row = f.rows.managed_workspace_fee_policies![0]!;
    expect([row.reserve_target_cents, row.repair_approval_threshold_cents]).toEqual([0, 25_000]);
    expect(activateRpc(
      { p_id: d.id, p_via: "owner_signature", p_snapshot: v2Snapshot(d), p_hash: "h" },
      f,
    )).toMatchObject({ status: "active" });
  });

  // It is a tolerance, not a hole: a term the snapshot never carried cannot be vouched for once it was SET.
  it("refuses a v2 snapshot once either v3 term was moved off its default", async () => {
    for (const edit of [{ reserve_target_cents: 250_000 }, { repair_approval_threshold_cents: 500_000 }]) {
      const f = seed();
      const d = await createDraftPolicy(f.db, admin, input);
      await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
      Object.assign(f.rows.managed_workspace_fee_policies![0]!, edit);
      expect(activateRpc(
        { p_id: d.id, p_via: "owner_signature", p_snapshot: v2Snapshot(d), p_hash: "h" },
        f,
      )).toMatchObject({ reason: "terms_changed" });
    }
  });

  it("a v3 snapshot is still compared on both new terms, default or not", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, { ...input, terms: { ...terms, repairApprovalThresholdCents: 400_000 } });
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    // Named and matching: accepted even though it is not the column default.
    expect(await signPolicy(f.db, OWNER, d.id, policyTermsHash(d))).toMatchObject({ status: "active" });
    // Named and NOT matching: refused.
    const g = seed();
    const e = await createDraftPolicy(g.db, admin, input);
    await sendPolicyForSignature(g.db, admin, e.id, new Date("2026-10-18T20:00:00Z"));
    expect(activateRpc(
      { p_id: e.id, p_via: "owner_signature", p_hash: "h", p_snapshot: { ...v2Snapshot(e), reserveTargetCents: 99, repairApprovalThresholdCents: 25_000 } },
      g,
    )).toMatchObject({ reason: "terms_changed" });
  });

  it("an unsent draft cannot take an owner signature, even past the TypeScript check", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    // The row was never sent: the function refuses whatever the caller believed.
    expect(activateRpc({ p_id: d.id, p_via: "owner_signature", p_snapshot: {} }, f)).toMatchObject({ reason: "not_sent" });
  });

  it("is idempotent, and refuses once the owner left the team", async () => {
    const { f, id, hash } = await sent();
    await signPolicy(f.db, OWNER, id, hash);
    expect((await signPolicy(f.db, OWNER, id, hash)).status).toBe("active");
    const g = seed();
    const d = await createDraftPolicy(g.db, admin, input);
    await sendPolicyForSignature(g.db, admin, d.id);
    g.rows.account_link_invites = [];
    await expect(signPolicy(g.db, OWNER, d.id, policyTermsHash(d))).rejects.toMatchObject({ status: 403 });
  });
  it("refuses a draft that was never sent", async () => {
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await expect(signPolicy(f.db, OWNER, d.id, policyTermsHash(d))).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a signature taken against terms the owner was not shown", async () => {
    // The owner opens the draft at 10%; an admin edits it to 30% and re-sends. The still-open page's POST must
    // not activate the new terms with the owner's signature on them. This is a fee agreement.
    const f = seed();
    const d = await createDraftPolicy(f.db, admin, input);
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T20:00:00Z"));
    const shownToOwner = policyTermsHash(d);
    const edited = await updateDraftPolicy(f.db, admin, d.id, { terms: { ...terms, ownerShareBps: 7000 } });
    await sendPolicyForSignature(f.db, admin, d.id, new Date("2026-10-18T22:00:00Z"));
    await expect(signPolicy(f.db, OWNER, d.id, shownToOwner)).rejects.toMatchObject({ status: 409 });
    expect(await loadActivePolicyForWorkspace(f.db, WS)).toBeNull();
    // The hash of what is actually on the page signs it.
    expect((await signPolicy(f.db, OWNER, d.id, policyTermsHash(edited))).status).toBe("active");
  });
  it("refuses a missing or malformed hash rather than signing whatever is stored", async () => {
    const { f, id } = await sent();
    for (const bad of ["", "nope", "a".repeat(63)]) {
      await expect(signPolicy(f.db, OWNER, id, bad)).rejects.toMatchObject({ status: 400 });
    }
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
    f.db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ not: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { code: "XX000" } }) }) }) }) }) }) }) } as never;
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
