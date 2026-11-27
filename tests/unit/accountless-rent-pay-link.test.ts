import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
const getStripe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe", () => ({ getStripe }));

import { resolveLinkDestination } from "@/lib/one-number/link-destinations.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { hashPhoneBoundToken } from "@/lib/one-number/links.server";
import {
  accountlessResidentPhoneKeys,
  isDeletedResidentEmail,
  phonesFromLeaseRow,
} from "@/lib/payments/accountless-resident-phone.server";
import { mintResidentRentPayLink } from "@/lib/payments/rent-reminder-links.server";
import { createHouseholdChargeCheckout, loadHouseholdChargesForCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { assertResidentCheckoutAttemptTerms, assertResidentCheckoutSession, type ResidentCheckoutAttempt } from "@/lib/resident-checkout-claim.server";
import { linksFakeDb } from "../helpers/links-fake-db";

/**
 * An imported resident (placeholder address, no PropLane login, `resident_user_id` null) pays their own rent from a
 * phone-bound link bound to the phone on their lease. Before this, every such link resolved to "expired" and the
 * checkout reservation refused a payer without an account, so none of them could pay through PropLane at all.
 */

const WS = "ws-a";
const MANAGER = "owner-a";
const HOUSE = "prop-1";
const EMAIL = "grace-4709a-room1@import.proplane.local";
const PHONE = "2065550142";

const charge = (over: Record<string, unknown> = {}) => ({
  id: "hc_dec", residentUserId: null, residentEmail: EMAIL, residentName: "Grace Natalie Halverson", propertyId: HOUSE,
  managerUserId: MANAGER, title: "Rent — December 2026", amountLabel: "$900.00", balanceLabel: "$900.00",
  propertyLabel: "4709a 8th Ave", status: "pending", kind: "rent", rentMonth: "2026-12", ...over,
});

const lease = (over: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) => ({
  id: "lease-1", manager_user_id: MANAGER, property_id: HOUSE, resident_email: EMAIL, resident_user_id: null,
  updated_at: "2026-11-01T00:00:00Z",
  row_data: { application: { phone: "(206) 555-0142" }, leaseIntake: { phone: "206-555-0142" }, ...rowData },
  ...over,
});

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
  return linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: MANAGER, is_default: true }],
    manager_property_records: [{ id: HOUSE, workspace_id: WS, manager_user_id: MANAGER }],
    profiles: [{ id: "res-1", phone: "(206) 555-0177", phone_verified_at: "2026-09-01T00:00:00Z" }],
    portal_household_charge_records: [
      { id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: null, row_data: charge() },
    ],
    portal_lease_pipeline_records: [lease()],
    manager_application_records: [],
    ...extra,
  });
}

const rentLink = (over: Partial<PhoneBoundLink> = {}): PhoneBoundLink => ({
  id: "link-1", phoneKey: PHONE, workspaceId: WS, purpose: "rent", targetType: "charge", targetId: "hc_dec",
  requiresOtp: true, expiresAt: null, usedAt: null, revokedAt: null, openCount: 0, createdBy: null, ...over,
});

describe("the phone on file for a resident with no login", () => {
  it("reads the lease's application and intake phones, never a voided lease or another address", async () => {
    expect(phonesFromLeaseRow({ application: { phone: "+1 206 555 0142" } })).toEqual([PHONE]);
    expect(phonesFromLeaseRow({ voidedAt: "2026-10-01", application: { phone: "2065550142" } })).toEqual([]);
    expect(await accountlessResidentPhoneKeys(world().db, { managerUserId: MANAGER, propertyId: HOUSE, residentEmail: EMAIL.toUpperCase() })).toEqual([PHONE]);
    expect(await accountlessResidentPhoneKeys(world().db, { managerUserId: MANAGER, propertyId: HOUSE, residentEmail: "other@import.proplane.local" })).toEqual([]);
    expect(await accountlessResidentPhoneKeys(world().db, { managerUserId: "someone-else", propertyId: HOUSE, residentEmail: EMAIL })).toEqual([]);
    // A lease that names an account is that account's: its verified phone counts, not the typed one.
    const owned = world({ portal_lease_pipeline_records: [lease({ resident_user_id: "res-1" })] });
    expect(await accountlessResidentPhoneKeys(owned.db, { managerUserId: MANAGER, propertyId: HOUSE, residentEmail: EMAIL })).toEqual([]);
    expect(isDeletedResidentEmail("deleted-2dec04a2-3b2b-4ff8-80b9-5040a6ccecd6@deleted.invalid")).toBe(true);
    expect(isDeletedResidentEmail(EMAIL)).toBe(false);
  });
});

describe("rent link destination for a resident with no login", () => {
  it("opens the December charge for the phone on the lease, card only", async () => {
    expect(await resolveLinkDestination(world().db, rentLink())).toEqual({
      kind: "rent", chargeIds: ["hc_dec"], residentUserId: "", residentEmail: EMAIL, accountless: true,
      charges: [{ id: "hc_dec", title: "Rent — December 2026", amountLabel: "$900.00", propertyLabel: "4709a 8th Ave" }],
    });
  });

  it("says the number changed when the lease no longer carries the link's phone", async () => {
    expect(await resolveLinkDestination(world().db, rentLink({ phoneKey: "2065550199" }))).toEqual({ kind: "phone_changed" });
    const moved = world({ portal_lease_pipeline_records: [lease({}, { application: { phone: "2065550177" }, leaseIntake: {} })] });
    expect(await resolveLinkDestination(moved.db, rentLink())).toEqual({ kind: "phone_changed" });
    const none = world({ portal_lease_pipeline_records: [] });
    expect(await resolveLinkDestination(none.db, rentLink())).toEqual({ kind: "phone_changed" });
  });

  it("never mixes an account's charge with a login-less one, nor two addresses, nor a deleted account", async () => {
    const mixed = world({
      portal_household_charge_records: [
        { id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: null, row_data: charge() },
        { id: "hc_acct", status: "pending", manager_user_id: MANAGER, resident_user_id: "res-1", row_data: charge({ id: "hc_acct", residentUserId: "res-1" }) },
        { id: "hc_other", status: "pending", manager_user_id: MANAGER, resident_user_id: null, row_data: charge({ id: "hc_other", residentEmail: "heesu-5257-room1@import.proplane.local" }) },
      ],
    });
    expect(await resolveLinkDestination(mixed.db, rentLink({ targetId: "hc_dec,hc_acct" }))).toEqual({ kind: "gone" });
    expect(await resolveLinkDestination(mixed.db, rentLink({ targetId: "hc_dec,hc_other" }))).toEqual({ kind: "gone" });
    const deleted = world({
      portal_household_charge_records: [{ id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: null,
        row_data: charge({ residentEmail: "deleted-2dec04a2-3b2b-4ff8-80b9-5040a6ccecd6@deleted.invalid" }) }],
    });
    expect(await resolveLinkDestination(deleted.db, rentLink())).toEqual({ kind: "gone" });
  });

  it("a paid December charge reads as paid", async () => {
    const paid = world({
      portal_household_charge_records: [{ id: "hc_dec", status: "paid", manager_user_id: MANAGER, resident_user_id: null, row_data: charge({ status: "paid" }) }],
    });
    expect(await resolveLinkDestination(paid.db, rentLink())).toEqual({ kind: "paid" });
  });
});

describe("mintResidentRentPayLink", () => {
  it("mints a /l/ link bound to the lease phone, storing only the token's hash", async () => {
    const { db, rows } = world();
    const minted = await mintResidentRentPayLink(db, { chargeIds: ["hc_dec"], ownerUserId: MANAGER, origin: "https://www.proplane.ai" });
    expect(minted).toMatchObject({
      ok: true, phoneLast4: "0142", accountless: true, chargeIds: ["hc_dec"], firstName: "Grace", amountLabel: "$900.00",
    });
    if (!minted.ok) return;
    expect(minted.url).toMatch(/^https:\/\/www\.proplane\.ai\/l\/[A-Za-z0-9_-]{32,}$/);
    const stored = rows.phone_bound_links!.at(-1)!;
    expect(stored).toMatchObject({ phone_key: PHONE, workspace_id: WS, purpose: "rent", target_type: "charge", target_id: "hc_dec", requires_otp: true });
    const token = decodeURIComponent(minted.url.split("/l/")[1]!);
    expect(stored.token_hash).toBe(hashPhoneBoundToken(token));
    expect(JSON.stringify(rows.phone_bound_links)).not.toContain(token);
    // The link it made opens the same charge.
    expect(await resolveLinkDestination(db, rentLink())).toMatchObject({ kind: "rent", accountless: true });
  });

  it("refuses to guess between two numbers, or with none on file", async () => {
    const two = world({ portal_lease_pipeline_records: [lease({}, { leaseIntake: { phone: "2065550177" } })] });
    expect(await mintResidentRentPayLink(two.db, { chargeIds: ["hc_dec"] })).toEqual({ ok: false, error: "no_phone_on_file" });
    const none = world({ portal_lease_pipeline_records: [] });
    expect(await mintResidentRentPayLink(none.db, { chargeIds: ["hc_dec"] })).toEqual({ ok: false, error: "no_phone_on_file" });
  });

  it("uses an account's verified phone, and only a verified one", async () => {
    const acct = world({
      portal_household_charge_records: [{ id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: "res-1", row_data: charge({ residentUserId: "res-1" }) }],
    });
    expect(await mintResidentRentPayLink(acct.db, { chargeIds: ["hc_dec"] })).toMatchObject({ ok: true, phoneLast4: "0177", accountless: false });
    const unverified = world({
      profiles: [{ id: "res-1", phone: "(206) 555-0177", phone_verified_at: null }],
      portal_household_charge_records: [{ id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: "res-1", row_data: charge({ residentUserId: "res-1" }) }],
    });
    expect(await mintResidentRentPayLink(unverified.db, { chargeIds: ["hc_dec"] })).toEqual({ ok: false, error: "no_phone_on_file" });
  });

  it("refuses another manager's charge, a paid one, and a missing one", async () => {
    expect(await mintResidentRentPayLink(world().db, { chargeIds: ["hc_dec"], ownerUserId: "owner-b" })).toEqual({ ok: false, error: "not_yours" });
    const paid = world({
      portal_household_charge_records: [{ id: "hc_dec", status: "paid", manager_user_id: MANAGER, resident_user_id: null, row_data: charge({ status: "paid" }) }],
    });
    expect(await mintResidentRentPayLink(paid.db, { chargeIds: ["hc_dec"] })).toEqual({ ok: false, error: "not_payable" });
    expect(await mintResidentRentPayLink(world().db, { chargeIds: ["missing"] })).toEqual({ ok: false, error: "charge_not_found" });
    expect(await mintResidentRentPayLink(world().db, { chargeIds: [] })).toEqual({ ok: false, error: "charge_not_found" });
  });
});

describe("checkout core for a login-less payer", () => {
  function chargeDb(over: { residentUserId?: string | null; residentEmail?: string } = {}) {
    return { from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          if (table === "portal_household_charge_records") {
            return { data: { id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: over.residentUserId ?? null,
              row_data: charge({ residentUserId: over.residentUserId ?? null, residentEmail: over.residentEmail ?? EMAIL }) }, error: null };
          }
          throw new Error(`PAST_OWNERSHIP:${table}`);
        },
      };
      return query;
    } };
  }

  it("accepts a charge with no account for this exact address, and nothing else", async () => {
    await expect(loadHouseholdChargesForCheckout(chargeDb() as never, {
      userId: "", userEmail: EMAIL, chargeIds: ["hc_dec"], accountlessResident: true,
    })).rejects.toThrow("PAST_OWNERSHIP");
    expect(await loadHouseholdChargesForCheckout(chargeDb({ residentUserId: "res-1" }) as never, {
      userId: "", userEmail: EMAIL, chargeIds: ["hc_dec"], accountlessResident: true,
    })).toMatchObject({ ok: false, status: 403 });
    expect(await loadHouseholdChargesForCheckout(chargeDb() as never, {
      userId: "", userEmail: "heesu-5257-room1@import.proplane.local", chargeIds: ["hc_dec"], accountlessResident: true,
    })).toMatchObject({ ok: false, status: 403 });
    // A caller that names an account cannot also claim to have none.
    expect(await loadHouseholdChargesForCheckout(chargeDb() as never, {
      userId: "res-1", userEmail: EMAIL, chargeIds: ["hc_dec"], accountlessResident: true,
    })).toMatchObject({ ok: false, status: 403 });
  });

  it("says a login is needed when an ordinary caller passes no account, instead of failing at the reservation", async () => {
    expect(await loadHouseholdChargesForCheckout(chargeDb() as never, {
      userId: "", userEmail: EMAIL, chargeIds: ["hc_dec"],
    })).toMatchObject({ ok: false, status: 422, code: "RESIDENT_ACCOUNT_REQUIRED" });
  });

  it("never starts a bank debit for a login-less payer", async () => {
    // The ownership read passes; the bank refusal comes before any provider or reservation call.
    const db = { from(table: string) {
      const query = {
        select() { return query; }, eq() { return query; },
        async maybeSingle() {
          if (table === "portal_household_charge_records") {
            return { data: { id: "hc_dec", status: "pending", manager_user_id: MANAGER, resident_user_id: null, row_data: charge() }, error: null };
          }
          if (table === "manager_property_records") {
            return { data: { manager_user_id: MANAGER, property_data: { listingSubmission: { v: 1, rooms: [], bathrooms: [], axisPaymentsEnabled: true } } }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return query;
    }, rpc: vi.fn() };
    const result = await createHouseholdChargeCheckout(db as never, {
      userId: "", userEmail: EMAIL, chargeIds: ["hc_dec"], mode: "embedded", paymentMethod: "ach",
      appOrigin: "https://www.proplane.ai", accountlessResident: true,
    });
    expect(result).toMatchObject({ ok: false, code: "PAYMENT_METHOD_DISABLED" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
  });
});

describe("a stored attempt with no resident account", () => {
  function attempt(over: { email: string; marker: boolean }): { attempt: ResidentCheckoutAttempt; session: Stripe.Checkout.Session } {
    const metadata: Record<string, string> = {
      purpose: "household_charge", source_arbitration_v: "1", resident_attempt_token: "token-1", charge_id: "hc_dec",
      charge_ids: "hc_dec", manager_user_id: MANAGER, resident_email: EMAIL, ...(over.marker ? { resident_account: "none" } : {}),
    };
    const a = {
      id: "attempt-1", attempt_token: "token-1", resident_user_id: null, resident_email: over.email, manager_user_id: MANAGER,
      charge_ids: ["hc_dec"], charge_cents: [90000], subtotal_cents: 90000, payer_total_cents: 90000, recipient_net_cents: 90000,
      payment_method: "card" as const, currency: "usd" as const, stripe_session_id: "cs_1", stripe_payment_intent_id: null,
      status: "pending" as const, created_at: new Date().toISOString(),
      provider_params: {
        idempotencyKey: "resident-checkout:token-1", residentEmail: EMAIL, mode: "embedded" as const, paymentMethod: "card" as const,
        lineItems: [{ amountCents: 90000, productName: "Rent — December 2026" }], metadata,
        destinationAccountId: null, fundingModel: "connect_destination" as const, feePayer: "proplane" as const, forceExplicitCard: true,
        fixedFeeBreakdown: { serviceFeeCents: 0, residentAddedFeeCents: 0, applicationFeeCents: 0, totalCents: 90000, managerPayoutCents: 90000 },
      },
    } satisfies ResidentCheckoutAttempt;
    const session = {
      id: "cs_1", mode: "payment", currency: "usd", amount_total: 90000, payment_status: "paid", status: "complete",
      metadata: { ...metadata, payment_method: "card", subtotal_cents: "90000", processing_fee_cents: "0",
        manager_payout_cents: "90000", fee_payer: "proplane", platform_hold: "1", hold_amount_cents: "90000" },
    } as unknown as Stripe.Checkout.Session;
    return { attempt: a, session };
  }

  it("reconciles a login-less attempt that keeps its address, so the webhook can settle it", () => {
    const { attempt: a, session } = attempt({ email: EMAIL, marker: true });
    expect(() => assertResidentCheckoutAttemptTerms(a)).not.toThrow();
    expect(() => assertResidentCheckoutSession(a, session)).not.toThrow();
  });

  it("still requires a scrubbed address for an unmarked one (an account deleted after paying)", () => {
    expect(() => assertResidentCheckoutAttemptTerms(attempt({ email: EMAIL, marker: false }).attempt)).toThrow(/reconcile/);
    expect(() => assertResidentCheckoutAttemptTerms(
      attempt({ email: "deleted-2dec04a2-3b2b-4ff8-80b9-5040a6ccecd6@deleted.invalid", marker: false }).attempt,
    )).not.toThrow();
    // The marker never vouches for a different address, and never rides on an attempt that has an account.
    expect(() => assertResidentCheckoutAttemptTerms(attempt({ email: "someone@example.com", marker: true }).attempt)).toThrow(/reconcile/);
    const owned = attempt({ email: EMAIL, marker: true }).attempt;
    owned.resident_user_id = "res-1";
    expect(() => assertResidentCheckoutAttemptTerms(owned)).toThrow(/reconcile/);
  });
});
