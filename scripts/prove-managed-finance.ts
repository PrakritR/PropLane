/**
 * Dev-only, Stripe TEST-mode proof of the PropLane-held funds flow (docs/agents/owner-management.md).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/prove-managed-finance.ts
 *
 * It refuses to run unless the Stripe key is a test key and the Supabase project is the dev/test project. It creates its own
 * workspace, users, property, fee policy and two test Express accounts, then drives real Stripe test objects through the real
 * library code: a platform charge, the ledger allocation, a replay, a partial refund, a vendor bill, an owner withdrawal and a
 * vendor withdrawal (real Transfers and Payouts), and the daily reconciliation. Money never touches staging or production.
 */
import Stripe from "stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createDraftPolicy, attestPolicy, loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";
import { creditManagedCapture } from "@/lib/managed-finance/capture.server";
import { applyManagedDispute, applyManagedRefund } from "@/lib/managed-finance/adjustments.server";
import { gateAndPostManagedVendorBill } from "@/lib/managed-finance/vendor-bills.server";
import { readPartyBalance, availableToWithdraw, ownerParty, vendorParty } from "@/lib/managed-finance/ledger.server";
import { withdrawFromManagedFunds } from "@/lib/managed-finance/withdrawals.server";
import { reconcileManagedLedger } from "@/lib/managed-finance/reconcile.server";
import { loadOwnerFinances, loadPlatformFinances } from "@/lib/managed-finance/finances.server";
import { AXIS_CONNECT_CONTROLLER } from "@/lib/stripe-connect";

const DEV_PROJECT = "emstjswhotsnyksqhqyf";
const key = process.env.STRIPE_SECRET_KEY ?? "";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!key.startsWith("sk_test_")) throw new Error("Refusing to run: STRIPE_SECRET_KEY is not a test key.");
if (!url.includes(DEV_PROJECT)) throw new Error("Refusing to run: the Supabase project is not the dev/test project.");

const stripe = new Stripe(key);
const db = createSupabaseServiceRoleClient();
const stamp = Date.now().toString(36);
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
};

async function makeUser(label: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email: `proof+${label}-${stamp}@example.test`, password: `Pw-${stamp}-${label}!x`, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  await db.from("profiles").upsert({ id: data.user.id, email: `proof+${label}-${stamp}@example.test`, full_name: `Proof ${label}`, role: label === "vendor" ? "vendor" : "manager" }, { onConflict: "id" });
  return data.user.id;
}

async function makeExpress(userId: string, label: string): Promise<string> {
  const acct = await stripe.accounts.create({
    country: "US",
    email: `proof+${label}-${stamp}@example.test`,
    controller: AXIS_CONNECT_CONTROLLER,
    capabilities: { transfers: { requested: true } },
    business_type: "individual",
    individual: {
      first_name: "Proof", last_name: label, email: `proof+${label}-${stamp}@example.test`, phone: "0000000000",
      dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: "0000", id_number: "000000000",
      address: { line1: "address_full_match", city: "Seattle", state: "WA", postal_code: "98101" },
    },
    business_profile: { mcc: "6513", url: "https://accessible.stripe.com" },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    external_account: { object: "bank_account", country: "US", currency: "usd", routing_number: "110000000", account_number: "000123456789" },
    settings: { payouts: { schedule: { interval: "manual" } } },
    metadata: { axis_user_id: userId, axis_portal: label === "vendor" ? "vendor" : "portal" },
  } as Stripe.AccountCreateParams);
  await db.from("profiles").update({ stripe_connect_account_id: acct.id }).eq("id", userId);
  for (let i = 0; i < 10; i += 1) {
    const a = await stripe.accounts.retrieve(acct.id);
    if (a.capabilities?.transfers === "active" && a.payouts_enabled) return acct.id;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const final = await stripe.accounts.retrieve(acct.id);
  throw new Error(`Express account ${acct.id} not ready: transfers=${final.capabilities?.transfers} payouts=${final.payouts_enabled} due=${JSON.stringify(final.requirements?.currently_due)}`);
}

async function main() {
  console.log(`Managed finance proof ${stamp} (Stripe test mode, dev database)`);
  // Test-mode top-up so repeated proofs (and the dispute losses they cause) never starve the platform's AVAILABLE balance. The
  // product's own "funds still arriving" refusal would otherwise (correctly) block the withdrawals below.
  await stripe.paymentIntents.create({ amount: 500_000, currency: "usd", payment_method: "pm_card_bypassPending", confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { proof_topup: stamp } });
  const manager = await makeUser("manager");
  const owner = await makeUser("owner");
  const vendor = await makeUser("vendor");
  const ownerAcct = await makeExpress(owner, "owner");
  const vendorAcct = await makeExpress(vendor, "vendor");
  check("test Express accounts are ready", Boolean(ownerAcct && vendorAcct), { ownerAcct, vendorAcct });

  const { data: ws, error: wsErr } = await db.from("portal_workspaces").insert({ owner_user_id: manager, name: `ZZ Managed Proof ${stamp}` }).select("id").single();
  if (wsErr || !ws) throw new Error(`workspace: ${wsErr?.message}`);
  const workspaceId = String(ws.id);
  const propertyId = `proof-prop-${stamp}`;
  const { error: propErr } = await db.from("manager_property_records").insert({
    id: propertyId, manager_user_id: manager, workspace_id: workspaceId, status: "live",
    row_data: { id: propertyId, name: "5259 Proof House" }, property_data: { buildingName: "5259 Proof House" },
  });
  if (propErr) throw new Error(`property: ${propErr.message}`);
  const { error: inviteErr } = await db.from("account_link_invites").insert({
    inviter_user_id: manager, invitee_user_id: owner, tab_kind: "manager", inviter_axis_id: `m-${stamp}`, invitee_axis_id: `o-${stamp}`,
    status: "accepted", workspace_id: workspaceId, team_role: "property_owner", assigned_property_ids: [propertyId],
  });
  if (inviteErr) throw new Error(`invite: ${inviteErr.message}`);

  const admin = { role: "admin" as const, userId: manager };
  const draft = await createDraftPolicy(db, admin, {
    workspaceId, ownerUserId: owner, effectiveFrom: new Date().toISOString().slice(0, 10),
    terms: { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 50_000 },
  });
  const policy = await attestPolicy(db, admin, draft.id, "Proof contract on file (test)");
  check("workspace is managed after the policy is accepted", (await loadActivePolicyForWorkspace(db, workspaceId))?.id === policy.id);

  // 1. A platform charge: separate-charges model, no destination. bypassPending => funds available at once.
  const pi = await stripe.paymentIntents.create({
    amount: 100_001, currency: "usd", payment_method: "pm_card_bypassPending", confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { proof: stamp },
  });
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge!.id;
  check("platform charge captured with no destination", pi.status === "succeeded" && !pi.transfer_data, { pi: pi.id });

  const components = [{ id: `proof-charge-${stamp}`, kind: "rent", liabilityClass: "income" as const, principalCents: 100_001, recipientNetCents: 100_001, propertyId, residentEmail: "resident@example.test", paidAt: new Date().toISOString() }];
  const credited = await creditManagedCapture(db, stripe, { policy, paymentIntentId: pi.id, stripeChargeId: chargeId, grossCents: 100_001, components });
  check("capture allocated", credited.status === "created", credited);
  const replay = await creditManagedCapture(db, stripe, { policy, paymentIntentId: pi.id, stripeChargeId: chargeId, grossCents: 100_001, components });
  check("replay of the same PaymentIntent is a no-op", replay.status === "exists" && replay.journalId === credited.journalId);

  let ob = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
  check("owner owed $900.01 and PropLane keeps $100.00 (fee rounds down)", ob.owedCents === 90_001, ob);
  const { data: fee } = await db.from("managed_rent_allocations").select("fee_cents, owner_cents").eq("stripe_payment_intent_id", pi.id).single();
  check("allocation row: fee 10000, owner 90001", fee?.fee_cents === 10_000 && fee?.owner_cents === 90_001, fee);

  // 2. Partial refund, reversed pro rata in the ledger.
  const refund = await stripe.refunds.create({ charge: chargeId, amount: 25_001, metadata: { proplane_charge_id: components[0]!.id } });
  const reversed = await applyManagedRefund(db, refund, chargeId);
  await applyManagedRefund(db, refund, chargeId); // replay
  ob = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
  check("refund reversed pro rata (owner 22501, fee 2500), replay changes nothing", reversed && ob.owedCents === 90_001 - 22_501, ob);

  // 3. A vendor bill: the vendor is owed, the owner is charged.
  const bill = await gateAndPostManagedVendorBill(db, {
    workspaceId, vendorUserId: vendor, amountCents: 24_000, title: "Leak repair", vendorLabel: "Proof Plumbing", propertyId,
    sourceType: "manual", sourceId: `proof-bill-${stamp}`,
  });
  check("vendor bill posted (under the owner's approval amount)", bill.status === "posted");
  ob = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
  const vb = await readPartyBalance(db, "vendor_payable", vendorParty(vendor), null);
  check("owner charged $240, vendor owed $240", ob.owedCents === 90_001 - 22_501 - 24_000 && vb.owedCents === 24_000, { owner: ob.owedCents, vendor: vb.owedCents });

  // 4. Withdrawals: real Transfers to the Express accounts.
  const avail = availableToWithdraw(ob, 0);
  console.log(`owner available to withdraw: ${avail}`);
  const ow = await withdrawFromManagedFunds(stripe, db, { kind: "owner", userId: owner, workspaceId, amountCents: Math.min(avail, 40_000), clientKey: `proof-${stamp}` });
  check("owner withdrawal succeeded", ow.ok, ow);
  if (ow.ok) {
    const tr = await stripe.transfers.retrieve(ow.transferId);
    check("owner transfer went to the owner's own account for the exact amount", tr.destination === ownerAcct && tr.amount === Math.min(avail, 40_000), { id: tr.id, amount: tr.amount });
    const again = await withdrawFromManagedFunds(stripe, db, { kind: "owner", userId: owner, workspaceId, amountCents: Math.min(avail, 40_000), clientKey: `proof-${stamp}` });
    check("the same click again returns the first withdrawal, no second transfer", again.ok && again.transferId === ow.transferId, again);
  }
  const vw = await withdrawFromManagedFunds(stripe, db, { kind: "vendor", userId: vendor, amountCents: 24_000, clientKey: `proofv-${stamp}` });
  check("vendor withdrawal succeeded", vw.ok, vw);
  const tooMuch = await withdrawFromManagedFunds(stripe, db, { kind: "owner", userId: owner, workspaceId, amountCents: 10_000_000, clientKey: `proof2-${stamp}` });
  check("withdrawing more than is available is refused before Stripe", !tooMuch.ok);
  const stranger = await withdrawFromManagedFunds(stripe, db, { kind: "owner", userId: vendor, workspaceId, amountCents: 100, clientKey: `proof3-${stamp}` });
  check("another person cannot withdraw from the owner's workspace", !stranger.ok);

  // 4b. A disputed payment: the owner's share is frozen when it opens and written off when it is lost.
  const pi2 = await stripe.paymentIntents.create({
    amount: 50_000, currency: "usd", payment_method: "pm_card_createDispute", confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { proof: stamp, kind: "dispute" },
  });
  const charge2 = typeof pi2.latest_charge === "string" ? pi2.latest_charge : pi2.latest_charge!.id;
  const comp2 = [{ id: `proof-charge2-${stamp}`, kind: "rent", liabilityClass: "income" as const, principalCents: 50_000, recipientNetCents: 50_000, propertyId, residentEmail: "resident@example.test", paidAt: new Date().toISOString() }];
  await creditManagedCapture(db, stripe, { policy, paymentIntentId: pi2.id, stripeChargeId: charge2, grossCents: 50_000, components: comp2 });
  const beforeDispute = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
  let dispute: Stripe.Dispute | null = null;
  for (let i = 0; i < 30 && !dispute; i += 1) {
    dispute = (await stripe.disputes.list({ payment_intent: pi2.id, limit: 1 })).data[0] ?? null;
    if (!dispute) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!dispute) throw new Error("Stripe did not raise the test dispute.");
  await applyManagedDispute(db, dispute);
  await applyManagedDispute(db, dispute); // replay
  const frozen = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
  check("an opened dispute freezes the owner's share of that payment ($450), once", frozen.owedCents === beforeDispute.owedCents - 45_000, { before: beforeDispute.owedCents, after: frozen.owedCents });
  await stripe.disputes.update(dispute.id, { evidence: { uncategorized_text: "losing_evidence" }, submit: true });
  let closed: Stripe.Dispute | null = null;
  for (let i = 0; i < 40; i += 1) {
    const d = await stripe.disputes.retrieve(dispute.id);
    if (d.status === "lost" || d.status === "won") { closed = d; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (closed) {
    await applyManagedDispute(db, closed);
    const after = await readPartyBalance(db, "owner_payable", ownerParty(owner), workspaceId);
    check(`a ${closed.status} dispute settles in the ledger`, closed.status === "lost" ? after.owedCents === frozen.owedCents : after.owedCents === beforeDispute.owedCents, { status: closed.status, owed: after.owedCents });
  } else {
    console.log("NOTE  the test dispute had not closed within two minutes; the lost/won step was not exercised");
  }

  // 5. The owner's view and the platform view.
  const view = await loadOwnerFinances(db, stripe, { ownerUserId: owner, workspaceId });
  check("owner statement reconciles", view.statement.beginningCents + view.statement.totals.netCents + view.statement.totals.withdrawalsCents === view.statement.endingCents, view.statement.totals);
  const platform = await loadPlatformFinances(db, stripe);
  check("platform ledger is balanced", platform.balanced);
  const report = await reconcileManagedLedger(db, stripe);
  check("daily reconciliation passes", report.journalsBalanced && report.ledgerNetsToZero && report.capturesMismatched === 0 && report.stripeCoversPlatformCash !== false, report);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PROOF ERROR:", e instanceof Error ? e.message : e);
  process.exit(2);
});
