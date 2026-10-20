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

/** Mirrors activate_managed_policy: end the workspace's active version, activate the draft, atomically. */
function activateRpc(args: Record<string, unknown>, f: OwnerFakeDb) {
  const rows = f.rows.managed_workspace_fee_policies!;
  const row = rows.find((r) => r.id === args.p_id);
  if (!row) return { status: "refused", reason: "not_found" };
  if (row.status === "active") return { status: "exists" };
  if (row.status !== "draft") return { status: "refused", reason: "not_draft" };
  for (const other of rows) if (other.workspace_id === row.workspace_id && other.status === "active") other.status = "ended";
  Object.assign(row, { status: "active", signed_at: "2026-10-19T00:00:00Z", accepted_via: args.p_via, terms_sha256: args.p_hash, terms_snapshot: args.p_snapshot });
  return { status: "active" };
}

function seed(extra: Record<string, FakeRow[]> = {}) {
  return fakeOwnerDb(
    {
      portal_workspaces: [{ id: WS, owner_user_id: PL, name: "Seattle Homes" }],
      account_link_invites: [{ id: "i1", workspace_id: WS, invitee_user_id: OWNER, status: "accepted" }],
      profiles: [{ id: OWNER, email: "o@x.test", phone: "+12065550100", phone_verified_at: "2026-01-01" }],
      managed_workspace_fee_policies: [],
      ...extra,
    },
    { rpc: { activate_managed_policy: activateRpc } },
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
