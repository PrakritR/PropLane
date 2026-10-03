import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  effectiveApplicationFeeCents,
  loadManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import {
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { parseMoneyAmount } from "@/lib/parse-money";
import {
  residentServiceFeeBreakdown,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { applicationFeeLeaseTypeKey, listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import { placementApplicationFeeCents, stayPlacementLeaseTerm } from "@/lib/listing-placement-standard-fees";
import { AIRBNB_LEASE_TERM, LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { listingApplicationFeeChannels } from "@/lib/rental-application/application-fee-channel";
import {
  APPLICATION_FEE_CHECKOUT_PURPOSE,
  createAxisAchCheckoutSession,
} from "@/lib/stripe-axis-ach-checkout";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { loadWorkspacePaymentSettingsForProperty } from "@/lib/workspace-payment-settings.server";
import {
  listingPaymentWaiverCodeMatchesServer,
  resolveAccountOrListingWaiverGrantedServer,
} from "@/lib/payment-policy.server";

/**
 * The Stripe Checkout core for the rental application fee, extracted from
 * `/api/stripe/application-fee-checkout` so it is independently testable
 * (mirrors `stripe-household-charge-checkout.server.ts`). Every validation the
 * route enforces lives here: the property is really owned by the manager id
 * the caller supplied, ACH is enabled on the listing, the fee amount comes
 * from the SERVER-stored listing (never the client), and that manager's
 * Connect account is ready for destination charges.
 *
 * Who bears the payment service fee is resolved live from the manager's plan
 * + Pro setting via `resolveServiceFeePayer` — the SAME resolver and settings
 * loader resident charges use (`stripe-household-charge-checkout.server.ts`),
 * so Free/Pro/Business behave identically for an applicant as they do for a
 * resident. This supersedes the earlier "always face value, PropLane
 * absorbs" application-fee carve-out — see `docs/agents/resident-payments.md`.
 */

export type ApplicationFeeCheckoutFailure = {
  ok: false;
  status: number;
  code?: string;
  error: string;
};

function listingFromPropertyData(propertyData: unknown): ManagerListingSubmissionV1 | null {
  if (!propertyData || typeof propertyData !== "object") return null;
  const submission = (propertyData as { listingSubmission?: unknown }).listingSubmission;
  if (!submission || typeof submission !== "object") return null;
  if ((submission as { v?: unknown }).v !== 1) return null;
  return normalizeManagerListingSubmissionV1(submission as ManagerListingSubmissionV1);
}

function clampAmountCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const x = Math.round(n);
  if (x < 100 || x > 100_000) return 0;
  return x;
}

export { listingApplicationFeeRaw } from "@/lib/listing-application-fee";

/**
 * The lease term the fee is looked up under, only when the listing actually
 * offers it. A client can name any string here; one that is not on the
 * listing resolves to nothing and the one amount applies.
 */
function offeredLeaseTerm(
  listing: ManagerListingSubmissionV1 | null,
  leaseTerm: string | undefined,
): string | undefined {
  const term = String(leaseTerm ?? "").trim();
  if (!listing || !term) return undefined;
  const offered = new Set(resolveAllowedLeaseTerms(listing).map(applicationFeeLeaseTypeKey));
  return offered.has(applicationFeeLeaseTypeKey(term)) ? term : undefined;
}

/**
 * The stay type's own application fee for the room + lease type the applicant picked, in
 * cents -- the same resolver the listing quote reads (`listing-placement-standard-fees`).
 * `null` when the room is not known (an entire-home listing has no room to name), the room
 * is not on this listing, or that stay type typed no application fee of its own.
 */
function placementFeeCentsFor(
  listing: ManagerListingSubmissionV1 | null,
  input: { rentalType?: "standard" | "short_term"; leaseTerm?: string; roomId?: string },
): number | null {
  if (!listing) return null;
  const roomId = String(input.roomId ?? "").trim();
  const room = roomId ? (listing.rooms ?? []).find((r) => r.id === roomId) ?? null : null;
  const entireHomeFees = !room && isEntireHomeListing(listing) ? listing.entireHomeArrangementFees : undefined;
  if (!room && !entireHomeFees) return null;
  const offered = offeredLeaseTerm(listing, input.leaseTerm);
  const isStay = input.rentalType === "short_term" || offered === SHORT_TERM_LEASE_TERM || offered === AIRBNB_LEASE_TERM;
  return placementApplicationFeeCents(listing, {
    leaseTerm: isStay ? stayPlacementLeaseTerm(offered) : (offered ?? LONG_TERM_LEASE_TERM),
    room,
    entireHomeFees,
    isStay,
  });
}

export type ResolvedApplicationFeeProperty = {
  managerUserId: string;
  listing: ManagerListingSubmissionV1 | null;
  applicationFeeCents: number;
  /**
   * P003: the resolved application template's own advertised waiver code
   * (`PropertyApplicationTemplate.waiverCodeOverride`), when the applicant's
   * `applicationTemplateId` resolved to one that set it. A DISPLAY default
   * only — redemption is unchanged, still the existing account/property
   * `manager_application_fee_waiver_codes` lookup regardless of this value.
   */
  templateWaiverCodeOverride: string | null;
  /**
   * The STORED template id that actually matched `input.applicationTemplateId`
   * — `null` when the caller supplied none, or supplied one that matched no
   * stored template (in which case `applicationFeeCents` above is already the
   * account default). This is what gets stamped onto the Stripe session's
   * metadata, never the caller-supplied id verbatim, so later verification
   * always reads a value this same resolver already validated.
   */
  resolvedApplicationTemplateId: string | null;
};

/**
 * Verifies the client-supplied `managerUserId` really owns `propertyId`
 * (never trust it blindly — otherwise a fee could be routed to an arbitrary
 * manager's Connect account) and resolves the server-stored fee amount.
 *
 * Deliberately does NOT check that online payments are switched on — a listing
 * with payments paused still has an application fee (and can still issue
 * waiver codes for it), so this is shared by the fee preview, the waiver
 * redeem route, AND the Stripe checkout below, which layers its own
 * ACH-enabled check on top since only IT actually needs Stripe.
 */
export async function resolveApplicationFeeProperty(
  db: SupabaseClient,
  input: {
    propertyId: string;
    managerUserId: string;
    rentalType?: "standard" | "short_term";
    /**
     * The applicant's chosen lease type — a SELECTOR into the listing's stored
     * per-type fees, never an amount. An unknown or unoffered term simply falls
     * back to the one amount.
     */
    leaseTerm?: string;
    /**
     * The room the applicant picked -- a SELECTOR into the listing's stored rooms, never an
     * amount. With `leaseTerm` it names the placement whose own application fee (typed in
     * Pricing) replaces the account default; absent, nothing placement-specific applies.
     */
    roomId?: string;
    /**
     * P003: a SELECTOR (like `leaseTerm` above), never an amount — picks which
     * of the listing's stored `propertyApplicationTemplates` rows the
     * applicant actually applied with, so a template-level fee override can be
     * read from SERVER storage. An id that doesn't resolve to a stored
     * template (unknown, blank, or the listing carries none) simply falls
     * back to the account default exactly as before this existed.
     */
    applicationTemplateId?: string;
  },
  opts?: {
    /**
     * A 0 effective fee ("applications are free") is a NORMAL answer for the
     * read-only preview — the applicant simply passes through with no payment
     * step. Only the checkout/waiver paths, which exist purely to collect or
     * waive a real fee, treat 0 as a 422.
     */
    allowZeroFee?: boolean;
  },
): Promise<{ ok: true; value: ResolvedApplicationFeeProperty } | ApplicationFeeCheckoutFailure> {
  const { data: propertyRow } = await db
    .from("manager_property_records")
    .select("property_data, manager_user_id")
    .eq("id", input.propertyId)
    .maybeSingle();

  if (!propertyRow) {
    return {
      ok: false,
      status: 404,
      code: "PROPERTY_NOT_FOUND",
      error: "This listing is no longer available.",
    };
  }

  const ownerUserId = String(propertyRow.manager_user_id ?? "").trim();
  if (!ownerUserId) {
    return {
      ok: false,
      status: 404,
      code: "PROPERTY_NOT_FOUND",
      error: "This listing is no longer available.",
    };
  }

  const claimedManager = input.managerUserId.trim();
  if (claimedManager && claimedManager !== ownerUserId) {
    return { ok: false, status: 403, error: "This property is not owned by the specified manager." };
  }

  const listing = listingFromPropertyData(propertyRow?.property_data);
  // P003: the applicant's `applicationTemplateId` is a selector into the
  // SAME server-stored listing row already loaded above — never a second
  // fetch the caller could point elsewhere, and never a client-supplied
  // amount. An id that matches nothing (unknown template, none stored, or no
  // id supplied) resolves `templateFeeCentsOverride` to `undefined`, which
  // `effectiveApplicationFeeCents` treats identically to "not set".
  const templateId = input.applicationTemplateId?.trim();
  const matchedTemplate = templateId
    ? readPropertyApplicationTemplates(listing ?? { propertyApplicationTemplates: [] }).find((t) => t.id === templateId)
    : undefined;
  // The Application system fee is authoritative for EVERY listing, including an explicit
  // 0 (free); listing fees are ignored (PLAN-0924-1254, docs/agents/resident-payments.md).
  // `effectiveApplicationFeeCents` owns that rule; the listing value is still passed only
  // through its deprecated parameter.
  const managerSettings = await loadManagerApplicationSettings(db, ownerUserId);
  const rawListingFee = listingApplicationFeeRaw(listing, input.rentalType, offeredLeaseTerm(listing, input.leaseTerm));
  const listingFeeCents =
    rawListingFee === "" ? null : clampAmountCents(parseMoneyAmount(rawListingFee) * 100);
  const applicationFeeCents = clampAmountCents(
    effectiveApplicationFeeCents({
      managerFeeCents: managerSettings.applicationFeeCents,
      templateFeeCentsOverride: matchedTemplate?.feeCentsOverride ?? null,
      placementFeeCents: placementFeeCentsFor(listing, input),
      listingFeeCents,
    }),
  );
  if (applicationFeeCents <= 0 && !opts?.allowZeroFee) {
    return { ok: false, status: 422, code: "NO_APPLICATION_FEE", error: "This listing has no application fee configured." };
  }

  return {
    ok: true,
    value: {
      managerUserId: ownerUserId,
      listing,
      applicationFeeCents,
      templateWaiverCodeOverride: matchedTemplate?.waiverCodeOverride?.trim() || null,
      resolvedApplicationTemplateId: matchedTemplate?.id ?? null,
    },
  };
}

/**
 * Lead review follow-up (2026-09-27): an applicant chooses
 * `applicationTemplateId` when requesting a fee preview/checkout, so a
 * dishonest one could pay for a CHEAP template (e.g. a $0 override) while
 * actually submitting the application under a different, pricier one — the
 * checkout resolver was already server-side-safe about the AMOUNT it
 * charged, but nothing compared that paid template/amount against what the
 * application is actually submitted under. Pure — no I/O, easy to test in
 * isolation from Stripe/DB.
 */
export function applicationFeePaymentSatisfiesTemplate(input: {
  /** The template the application is ACTUALLY being submitted under. */
  submittedApplicationTemplateId: string | null | undefined;
  /** The template resolved and stamped on the PAID session's metadata. */
  paidApplicationTemplateId: string | null | undefined;
  /** Cents actually paid (from the session's own `fee_cents` metadata). */
  paidFeeCents: number;
  /** The fee currently required for `submittedApplicationTemplateId`, freshly re-resolved. */
  requiredFeeCents: number;
}): boolean {
  const submitted = (input.submittedApplicationTemplateId ?? "").trim();
  const paid = (input.paidApplicationTemplateId ?? "").trim();
  // Same template (including "no template selected" on both sides — a
  // listing with a single template/no overrides never has anything to
  // mismatch) is always satisfied regardless of amount: it is the exact
  // charge the applicant already completed.
  if (submitted === paid) return true;
  // A different template is still fine as long as what was actually paid
  // covers what the ACTUAL template now requires (e.g. overpaying, or two
  // templates that happen to charge the same amount).
  return input.paidFeeCents >= input.requiredFeeCents;
}

/**
 * Re-resolves the fee currently required for one application template,
 * reusing the exact same server-side resolver the checkout/preview routes
 * use — never a second fee calculation. `managerUserId` here is the KNOWN,
 * already-trusted owner of the record being checked (read from the stored
 * row, never a caller-supplied claim), so the resolver's ownership guard is
 * a same-value no-op rather than a real authorization check at this call site.
 */
export async function resolveRequiredApplicationFeeCents(
  db: SupabaseClient,
  input: {
    propertyId: string;
    managerUserId: string;
    applicationTemplateId?: string | null;
    rentalType?: "standard" | "short_term";
    leaseTerm?: string;
    roomId?: string;
  },
): Promise<number> {
  const resolved = await resolveApplicationFeeProperty(
    db,
    {
      propertyId: input.propertyId,
      managerUserId: input.managerUserId,
      applicationTemplateId: input.applicationTemplateId ?? undefined,
      rentalType: input.rentalType,
      leaseTerm: input.leaseTerm,
      roomId: input.roomId,
    },
    { allowZeroFee: true },
  );
  return resolved.ok ? resolved.value.applicationFeeCents : 0;
}

export type ApplicationFeeItemization = {
  applicationFeeCents: number;
  /** Added on top when the applicant bears it (Free tier, or Pro w/ resident choice); 0 otherwise. */
  serviceFeeCents: number;
  totalCents: number;
  feePayer: ServiceFeePayer;
  managerTier: "free" | "pro" | "business";
};

/**
 * Who bears the service fee + the itemized breakdown, WITHOUT creating any
 * Stripe object — used both to preview the charge before the applicant pays
 * and inside `createApplicationFeeCheckout` so the two can never drift.
 */
export async function resolveApplicationFeeItemization(
  db: SupabaseClient,
  managerUserId: string,
  applicationFeeCents: number,
  listing?: ManagerListingSubmissionV1 | null,
  /** The listing this fee is for, so its workspace can answer when the home has no choice of its own. */
  propertyId?: string | null,
): Promise<ApplicationFeeItemization> {
  const { tier: managerTierRaw, promoCode, readFailed } = await getManagerPurchaseSku(managerUserId);
    if (readFailed) throw new Error("Payment plan could not be verified. Try again.");
  const managerTier = normalizeManagerSkuTier(managerTierRaw) ?? "free";
  const managerSettings = await loadManagerManualPaymentSettings(db, managerUserId);
  const workspace = await loadWorkspacePaymentSettingsForProperty(db, managerUserId, propertyId);
  const feePayer = resolveServiceFeePayerFor({
    tier: managerTier,
    adminOverride: managerSettings.adminServiceFeeOverride,
    propertyChoice: listing?.serviceFeePayer ?? null,
    workspaceChoice: workspace.serviceFeePayer,
    managerChoice: managerSettings.serviceFeePayer,
    /* The workspace's own code counts alongside the account grant and the
       listing's code: PropLane pays is applied per workspace by a code. */
    waiverGranted:
      resolveAccountOrListingWaiverGrantedServer(promoCode, listing?.serviceFeeWaiverCode) ||
      listingPaymentWaiverCodeMatchesServer(workspace.serviceFeeWaiverCode),
  });
  const fee =
    applicationFeeCents <= 0
      ? { residentAddedFeeCents: 0, totalCents: Math.max(0, applicationFeeCents) }
      : residentServiceFeeBreakdown(applicationFeeCents, "card", feePayer);
  return {
    applicationFeeCents,
    serviceFeeCents: fee.residentAddedFeeCents,
    totalCents: fee.totalCents,
    feePayer,
    managerTier,
  };
}

export type ApplicationFeeCheckoutInput = {
  propertyId: string;
  residentEmail: string;
  residentName?: string;
  managerUserId: string;
  rentalType?: "standard" | "short_term";
  /** The applicant's lease type; picks the listing's per-type fee when one is set. */
  leaseTerm?: string;
  /** The applicant's room (a selector); with `leaseTerm` it picks the stay type's own application fee. */
  roomId?: string;
  /** P003: selects the stored application template's own fee override, when it set one. */
  applicationTemplateId?: string;
  /**
   * `embedded` renders the payment form INLINE in the application (the default
   * — the applicant never leaves the wizard); `hosted` redirects to Stripe's
   * page. Embedded needs `returnUrl`; hosted needs `successUrl` + `cancelUrl`.
   */
  mode?: "embedded" | "hosted";
  returnUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
};

export type ApplicationFeeCheckoutSuccess =
  | { ok: true; mode: "embedded"; clientSecret: string; sessionId: string; itemization: ApplicationFeeItemization }
  | { ok: true; mode: "hosted"; url: string; sessionId: string; itemization: ApplicationFeeItemization };

export async function createApplicationFeeCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: ApplicationFeeCheckoutInput,
): Promise<ApplicationFeeCheckoutSuccess | ApplicationFeeCheckoutFailure> {
  const resolved = await resolveApplicationFeeProperty(db, input);
  if (!resolved.ok) return resolved;
  const { managerUserId, applicationFeeCents, listing } = resolved.value;

  if (!listingApplicationFeeChannels(listing ?? undefined).ach) {
    return {
      ok: false,
      status: 422,
      code: "AXIS_PAYMENTS_DISABLED",
      error: "Online payments are not enabled for this property. Contact the manager before applying.",
    };
  }

  const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, managerUserId);

  const itemization = await resolveApplicationFeeItemization(
    db,
    managerUserId,
    applicationFeeCents,
    listing,
    input.propertyId,
  );

  const metadata: Record<string, string> = {
    purpose: APPLICATION_FEE_CHECKOUT_PURPOSE,
    property_id: input.propertyId.slice(0, 450),
    resident_email: input.residentEmail.toLowerCase().slice(0, 450),
    manager_user_id: managerUserId,
    // P003 follow-up (2026-09-27): record what was actually RESOLVED and
    // CHARGED for this session — the template selector (never trust it back
    // from the client) and the exact cents the applicant paid — so a later
    // step can prove "the application actually submitted matches what was
    // paid for" instead of trusting a bare `paid: true`. Empty string when
    // no template resolved (single-template/no-override listings), never
    // omitted, so a reader can tell "no template" from "field predates this".
    application_template_id: (resolved.value.resolvedApplicationTemplateId ?? "").slice(0, 120),
    fee_cents: String(applicationFeeCents),
  };
  if (input.residentName) metadata.resident_name = input.residentName.slice(0, 450);

  const mode = input.mode ?? "embedded";
  const result = await createAxisAchCheckoutSession(stripe, {
    residentEmail: input.residentEmail,
    amountCents: applicationFeeCents,
    productName: "Rental application fee",
    productDescription: `Listing ${input.propertyId.slice(0, 120)}`,
    metadata,
    mode,
    destinationAccountId,
    managerTier: itemization.managerTier,
    feePayer: itemization.feePayer,
    // Card method-class → Stripe Checkout surfaces Apple Pay / Google Pay on
    // eligible devices with a card-entry fallback. A one-time application fee
    // is a far cleaner mobile pay than an ACH bank-login handshake.
    paymentMethod: "card",
    returnUrl: input.returnUrl,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });

  if (result.mode === "embedded") {
    return { ok: true, mode: "embedded", clientSecret: result.clientSecret, sessionId: result.sessionId, itemization };
  }
  return { ok: true, mode: "hosted", url: result.url, sessionId: result.sessionId, itemization };
}
