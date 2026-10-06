import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  effectiveApplicationFeeCents,
  loadManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import {
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  residentServiceFeeBreakdown,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { applicationFeeLeaseTypeKey } from "@/lib/listing-application-fee";
import { resolveApplicationFeeBasis } from "@/lib/application-fee-by-room";
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
 * `rentalType` is also a client-supplied selector: a stay's fee applies only
 * when the listing really lets stays, so a long-term-only listing cannot be
 * quoted the short-term row by naming it.
 */
function offeredRentalType(
  listing: ManagerListingSubmissionV1 | null,
  rentalType: "standard" | "short_term" | undefined,
): "standard" | "short_term" {
  if (rentalType !== "short_term") return "standard";
  return listing?.shortTermRentalsAllowed || listing?.airbnbRentalsAllowed ? "short_term" : "standard";
}

/** Which level of the chain set the amount, recorded on the payment so a later fee change is explainable. */
export type ApplicationFeeSource = "room_term" | "template" | "listing" | "account";

export type ResolvedApplicationFeeProperty = {
  managerUserId: string;
  listing: ManagerListingSubmissionV1 | null;
  applicationFeeCents: number;
  /** Which level of the fee chain set `applicationFeeCents`. */
  feeSource: ApplicationFeeSource;
  /** The room (`whole` for a whole-home listing) the fee was computed for; null when no room resolved. */
  feeRoomId: string | null;
  /** The lease type the fee was computed for (as offered by the listing); empty when none. */
  feeLeaseTerm: string;
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
     * The applicant's first room choice (`roomChoice1`) - a SELECTOR into the
     * listing's stored rooms, never an amount. An id the listing does not
     * contain resolves no room, and the fee falls back down the chain.
     */
    roomChoice1?: string;
    /**
     * The bundle the applicant is applying for - a SELECTOR into the listing's stored bundles, never an
     * amount. A bundle placement reads the bundle's own application fee instead of a room's.
     */
    bundleId?: string;
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
  // The fee follows the room the applicant chose and the lease type they chose
  // (captain, 2026-10-03). Chain: that room's fee for that term -> the
  // application template's own fee -> the listing-level fee -> the Application
  // system setting -> legacy default (`effectiveApplicationFeeCents`). A typed 0
  // at any level means free. Every input is read from the stored listing; the
  // room id and term are selectors only.
  const managerSettings = await loadManagerApplicationSettings(db, ownerUserId);
  const feeLeaseTerm = offeredLeaseTerm(listing, input.leaseTerm);
  const basis = resolveApplicationFeeBasis(listing, {
    roomChoice1: input.roomChoice1,
    bundleId: input.bundleId,
    applicationTemplateId: matchedTemplate?.id,
    leaseTerm: feeLeaseTerm,
    rentalType: offeredRentalType(listing, input.rentalType),
  });
  // The resolver's placement level already folds in the template's fee under the room's own override
  // (room override -> template fee); the template value below is the same figure for an unplaced listing.
  const templateCents = matchedTemplate?.feeCentsOverride ?? null;
  const feeSource: ApplicationFeeSource =
    basis.level === "room"
      ? "room_term"
      : basis.level === "template" || templateCents !== null
        ? "template"
        : basis.listingCents !== null
          ? "listing"
          : "account";
  const applicationFeeCents = clampAmountCents(
    effectiveApplicationFeeCents({
      managerFeeCents: managerSettings.applicationFeeCents,
      roomTermFeeCents: basis.roomTermCents,
      templateFeeCentsOverride: templateCents,
      listingFeeCents: basis.listingCents,
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
      feeSource,
      feeRoomId: basis.roomId,
      feeLeaseTerm: feeLeaseTerm ?? "",
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
/**
 * Every selector the application fee is priced by, besides the template. A
 * paid fee only proves the applicant paid for THIS application when the whole
 * basis still matches; the fee is per room, per bundle, per lease type and per
 * rental type, so the template alone is not the basis.
 */
export type ApplicationFeeBasisSelectors = {
  roomId?: string | null | undefined;
  leaseTerm?: string | null | undefined;
  bundleId?: string | null | undefined;
  rentalType?: string | null | undefined;
};

const APPLICATION_FEE_BASIS_KEYS = ["roomId", "leaseTerm", "bundleId", "rentalType"] as const;

/**
 * True only when the paid basis provably equals the submitted one. An `undefined`
 * value on the PAID side (a session stamped before that selector was recorded)
 * is unknown, never a match — the amount check then has to carry the decision.
 */
export function applicationFeeBasisMatches(
  paid: ApplicationFeeBasisSelectors | null | undefined,
  submitted: ApplicationFeeBasisSelectors | null | undefined,
): boolean {
  if (!paid && !submitted) return true;
  if (!paid || !submitted) return false;
  return APPLICATION_FEE_BASIS_KEYS.every((key) => {
    const paidValue = paid[key];
    const submittedValue = submitted[key];
    if (paidValue === undefined) return submittedValue === undefined;
    return String(paidValue ?? "").trim() === String(submittedValue ?? "").trim();
  });
}

export function applicationFeePaymentSatisfiesTemplate(input: {
  /** The template the application is ACTUALLY being submitted under. */
  submittedApplicationTemplateId: string | null | undefined;
  /** The template resolved and stamped on the PAID session's metadata. */
  paidApplicationTemplateId: string | null | undefined;
  /** Cents actually paid (from the session's own `fee_cents` metadata). */
  paidFeeCents: number;
  /** The fee currently required for `submittedApplicationTemplateId`, freshly re-resolved. */
  requiredFeeCents: number;
  /** Room / bundle / lease type / rental type stamped on the PAID session. */
  paidFeeBasis?: ApplicationFeeBasisSelectors | null;
  /** The same selectors read off the draft about to be submitted. */
  submittedFeeBasis?: ApplicationFeeBasisSelectors | null;
}): boolean {
  const submitted = (input.submittedApplicationTemplateId ?? "").trim();
  const paid = (input.paidApplicationTemplateId ?? "").trim();
  // The exact charge the applicant already completed — same template AND the
  // same priced basis (including "nothing selected" on both sides) — is always
  // satisfied regardless of amount: the amount was validated server-side at
  // checkout time, and a manager's later price change never re-charges it.
  if (submitted === paid && applicationFeeBasisMatches(input.paidFeeBasis, input.submittedFeeBasis)) return true;
  // Anything else is fine only as long as what was actually paid covers what
  // the submitted template/room/bundle/term now requires (e.g. overpaying, or
  // two selectors that happen to be priced the same).
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
export async function resolveRequiredApplicationFee(
  db: SupabaseClient,
  input: {
    propertyId: string;
    managerUserId: string;
    applicationTemplateId?: string | null;
    roomChoice1?: string | null;
    bundleId?: string | null;
    leaseTerm?: string | null;
    rentalType?: "standard" | "short_term";
  },
  opts?: { failClosed?: boolean },
): Promise<{ cents: number; basis: ApplicationFeeBasisSelectors }> {
  const rentalType = input.rentalType === "short_term" ? "short_term" : "standard";
  const resolved = await resolveApplicationFeeProperty(
    db,
    {
      propertyId: input.propertyId,
      managerUserId: input.managerUserId,
      applicationTemplateId: input.applicationTemplateId ?? undefined,
      roomChoice1: input.roomChoice1 ?? undefined,
      bundleId: input.bundleId ?? undefined,
      leaseTerm: input.leaseTerm ?? undefined,
      rentalType: input.rentalType,
    },
    { allowZeroFee: true },
  );
  const bundleId = (input.bundleId ?? "").trim();
  if (!resolved.ok) {
    if (opts?.failClosed) throw new Error("Could not verify the current application fee.");
    return { cents: 0, basis: { roomId: "", leaseTerm: "", bundleId, rentalType } };
  }
  return {
    cents: resolved.value.applicationFeeCents,
    basis: {
      roomId: resolved.value.feeRoomId ?? "",
      leaseTerm: resolved.value.feeLeaseTerm,
      bundleId,
      rentalType,
    },
  };
}

export async function resolveRequiredApplicationFeeCents(
  db: SupabaseClient,
  input: {
    propertyId: string;
    managerUserId: string;
    applicationTemplateId?: string | null;
    roomChoice1?: string | null;
    bundleId?: string | null;
    leaseTerm?: string | null;
    rentalType?: "standard" | "short_term";
  },
): Promise<number> {
  return (await resolveRequiredApplicationFee(db, input)).cents;
}

/**
 * Stamped on every session this version of the checkout creates, so a reader can tell "the
 * checkout recorded the complete basis" from "this session predates part of it" WITHOUT relying
 * on an empty metadata value surviving the round trip through Stripe (an empty value is how
 * Stripe unsets a key, so an absent key and a stamped empty string are indistinguishable).
 */
export const APPLICATION_FEE_BASIS_VERSION = "1";

/**
 * Selectors whose stamped value is legitimately empty — no room on a whole-house listing, no
 * bundle on most applications, no lease type offered. A missing key for these can only mean
 * "nothing selected", never "not recorded".
 */
const APPLICATION_FEE_OPTIONAL_BASIS_KEYS = new Set(["fee_room_id", "fee_lease_term", "fee_bundle_id"]);

/**
 * The priced basis a paid Stripe session recorded. A selector the session never
 * stamped stays `undefined` (unknown), which `applicationFeeBasisMatches`
 * refuses to read as a match.
 */
export function applicationFeeBasisFromSessionMetadata(
  metadata: Record<string, string> | null | undefined,
): ApplicationFeeBasisSelectors {
  const complete = String(metadata?.fee_basis_v ?? "").trim() === APPLICATION_FEE_BASIS_VERSION;
  const read = (key: string): string | undefined => {
    const raw = metadata?.[key];
    if (raw !== undefined) return raw.trim();
    return complete || APPLICATION_FEE_OPTIONAL_BASIS_KEYS.has(key) ? "" : undefined;
  };
  return {
    roomId: read("fee_room_id"),
    leaseTerm: read("fee_lease_term"),
    bundleId: read("fee_bundle_id"),
    rentalType: read("fee_rental_type"),
  };
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
  /** The applicant's first room choice - a selector into the listing's stored rooms, never an amount. */
  roomChoice1?: string;
  /** The bundle applied for - a selector into the listing's stored bundles, never an amount. */
  bundleId?: string;
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
    // Which room / lease type this fee was computed for, and which level of the
    // fee chain set it. After payment a room or term change does NOT re-charge
    // or refund; this is the record of what the amount was based on.
    fee_room_id: (resolved.value.feeRoomId ?? "").slice(0, 120),
    fee_lease_term: resolved.value.feeLeaseTerm.slice(0, 40),
    fee_source: resolved.value.feeSource,
    // The remaining two selectors the fee is priced by. Without them a later
    // step cannot tell "this is the exact basis that was paid for" from "the
    // applicant changed what they are applying for after paying".
    fee_bundle_id: (input.bundleId ?? "").trim().slice(0, 120),
    fee_rental_type: input.rentalType === "short_term" ? "short_term" : "standard",
    fee_basis_v: APPLICATION_FEE_BASIS_VERSION,
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
