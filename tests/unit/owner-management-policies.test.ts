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

/**
 * Mirrors `activate_managed_policy` (migration 20261020150000): end the workspace's active version and activate the
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
  for (const other of rows) if (other.workspace_id === row.workspace_id && other.status === "active") other.status = "ended";
  Object.assign(row, { status: "active", signed_at: "2026-10-19T00:00:00Z", accepted_via: args.p_via, terms_sha256: args.p_hash, terms_snapshot: args.p_snapshot });
  return { status: "active" };
}

function seed(extra: Record<string, FakeRow[]> = {}, rpc: Record<string, (args: Record<string, unknown>, f: OwnerFakeDb) => unknown> = {}) {
  return fakeOwnerDb(
    {
      portal_workspaces: [{ id: WS, owner_user_id: PL, name: "Seattle Homes" }],
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

describe("the SQL mirror: the activation terms guard (migration 20261020150000)", () => {
  const sql = readFileSync("supabase/migrations/20261020150000_managed_policy_activation_terms_guard.sql", "utf8");

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
    for (const key of ["workspaceId", "ownerUserId", "ownerShareBps", "appliesTo", "leasingFeeBps", "minFeeCents", "effectiveFrom"]) {
      expect(sql).toContain(`p_snapshot->>'${key}'`);
    }
    // Compared as TEXT, so a malformed snapshot refuses instead of raising a cast error.
    expect(sql).toContain("v_pol.owner_share_bps::text");
    expect(sql).toContain("to_char(v_pol.effective_from, 'YYYY-MM-DD')");
  });

  it("refuses an owner signature on a draft that was never sent", () => {
    expect(sql).toContain("if p_via = 'owner_signature' and v_pol.sent_at is null then");
    expect(sql).toContain("'not_sent'");
  });
});

describe("the SQL mirror: the atomic phone-code start (migration 20261020150100)", () => {
  const sql = readFileSync("supabase/migrations/20261020150100_phone_otp_start_atomic.sql", "utf8");

  it("takes a per-phone lock before it counts anything", () => {
    const lockIdx = sql.indexOf("pg_advisory_xact_lock(hashtextextended('phone-otp:' || p_phone_key, 0))");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(sql.indexOf("select count(*) from public.phone_otp_challenges")).toBeGreaterThan(lockIdx);
  });

  it("keeps the same caps as SHARED_LINE_OTP_RULES, and retires before it inserts", () => {
    expect(sql).toContain("and purpose = p_purpose and created_at > v_now - interval '1 hour') >= 3");
    expect(sql).toContain("and created_at > v_now - interval '1 hour') >= 8");
    expect(sql).toContain("public.phone_auth_failed_code_count(p_phone_key, p_purpose) >= 10");
    const retireIdx = sql.indexOf("set consumed_at = v_now");
    const insertIdx = sql.indexOf("insert into public.phone_otp_challenges");
    expect(retireIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(retireIdx);
    // The retire is scoped to this phone + purpose + SUBJECT: a code for one link never retires another's.
    expect(sql).toContain("subject_id is not distinct from p_subject");
  });

  it("is service-role only", () => {
    expect(sql).toContain("revoke all on function public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.phone_otp_start(uuid, text, text, text, text, integer, timestamptz) to service_role;");
  });
});
