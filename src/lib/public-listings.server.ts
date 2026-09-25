import "server-only";
import type { MockProperty } from "@/data/types";
import { isPropertyActiveForLeads } from "@/lib/demo-property-pipeline";
import {
  resolveListingCtaSmsPhone,
  type ListingCtaManagerProfile,
} from "@/lib/listing-cta-phone.server";
import type {
  ManagerBathroomSubmission,
  ManagerBundleRow,
  ManagerListingSubmissionV1,
  ManagerQuickFactRow,
  ManagerRoomResidentPrice,
  ManagerRoomSubmission,
  ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { publicPropertyApplicationTemplate } from "@/lib/property-application-templates";
import {
  houseDefaultsForSubmission,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import type { ListingFeeRow } from "@/lib/listing-fees";
import { resolveListingCtaEmailsByManager } from "@/lib/listing-cta-email.server";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

function asProperty(value: unknown, id: string): MockProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = value as MockProperty;
  // `property_data` predates the typed listing writer and can contain partial
  // legacy/admin JSON. Public catalog callers assume these identity fields are
  // real strings (sorting calls title.localeCompare, while grouping uses the
  // building and address). Missing identity is not permission to invent public
  // copy from a different field, so fail closed and omit the malformed row.
  if (
    typeof property.title !== "string" || !property.title.trim()
    || typeof property.buildingName !== "string" || !property.buildingName.trim()
    || typeof property.address !== "string" || !property.address.trim()
  ) {
    return null;
  }
  return {
    ...property,
    id: typeof property.id === "string" && property.id.trim() ? property.id.trim() : id,
    title: property.title.trim(),
    buildingName: property.buildingName.trim(),
    address: property.address.trim(),
  };
}

// ---------------------------------------------------------------------------
// Public projection — DENY BY DEFAULT.
//
// `property_data` is a manager-owned JSON blob that the listing wizard writes
// verbatim, so spreading it into an anonymous response publishes whatever the
// wizard happened to store. That is how the manager's wifi password, their
// resident-only house notes, and the URL of their uploaded lease template ended
// up on an unauthenticated endpoint. The rule now is inverted: a field reaches
// a prospect only by being named here.
//
// A field earns a place on these lists when a prospect-facing surface (browse,
// listing detail, the public apply wizard, the AI housing-search + leasing SMS
// tools) actually reads it, or when it is pure listing marketing metadata. It
// is excluded when it is manager- or resident-internal: access credentials and
// instructions, lease configuration, billing policy, add-on service offers,
// proration internals. When you add a field to the submission, adding it here
// is a deliberate act with a reviewer, not a side effect.
// ---------------------------------------------------------------------------

/** Fields of `MockProperty` a prospect's browse and detail pages need. */
const PUBLIC_PROPERTY_KEYS = [
  "id",
  "title",
  "tagline",
  "address",
  "zip",
  "neighborhood",
  "beds",
  "baths",
  "rentLabel",
  "available",
  "petFriendly",
  "buildingId",
  "buildingName",
  "unitLabel",
  "mapLat",
  "mapLng",
  "managerUserId",
  "contactSmsPhone",
  "contactWorkEmail",
  "managerContactEmail",
  "adminPublishLive",
] as const satisfies readonly (keyof MockProperty)[];

/**
 * Submission fields a prospect may see. Every REQUIRED field of
 * `ManagerListingSubmissionV1` is listed (they are all benign listing copy or
 * pricing), because the listing renderers call `.trim()` / `.map()` on them
 * unguarded — dropping one throws `getListingRichContent` into its catch and
 * silently renders a generic demo listing in place of the real one.
 */
const PUBLIC_SUBMISSION_KEYS = [
  "v",
  // Identity + structure. Already public on the listing card.
  "buildingName",
  "address",
  "zip",
  "neighborhood",
  "homeStructureNote",
  "listingPropertyTypeId",
  "listingPlaceCategoryId",
  "listingStoriesId",
  "listingTotalBathroomsId",
  "listingBedroomSlots",
  // Whole-home size and lot: public facts a records lookup or the manager
  // fills in. `yearBuilt` stays private (it is a compliance input, see the
  // disclosure triggers) and so does `prefill` (what was filled and from where).
  "houseSizeSqft",
  "lotSizeSqft",
  // Marketing copy + media.
  "tagline",
  "alsoListedAs",
  "petFriendly",
  "houseOverview",
  // Ad titles / marketing notes the leasing SMS assistant matches on (PRP-426).
  "marketingNotes",
  "houseRulesText",
  "amenitiesText",
  "housePhotoDataUrls",
  "floorPlanByLabel",
  "propertyFloorPlanDataUrl",
  "quickFacts",
  // Rooms, baths, shared spaces, bundles (each further allowlisted below).
  "rooms",
  "bathrooms",
  "sharedSpaces",
  "bundles",
  // The price sheet a prospect is quoted, long-term and short-term.
  "entireHomeMonthlyRent",
  "entireHomeUtilitiesEstimate",
  "entireHomeUtilitiesPaymentModel",
  "applicationFee",
  "securityDeposit",
  "moveInFee",
  "holdingDeposit",
  "holdingDepositTiming",
  "paymentAtSigningIncludes",
  "houseCostsDetail",
  "parkingMonthly",
  "hoaMonthly",
  "otherMonthlyFees",
  "customFees",
  "monthToMonthSurcharge",
  "customLeaseSurcharge",
  "allowedLeaseTerms",
  "leaseTermsBody",
  "shortTermRentalsAllowed",
  "shortTermRequirements",
  "shortTermDailyCost",
  "shortTermDeposit",
  "shortTermMoveInFee",
  "shortTermHoldingDeposit",
  "shortTermParkingMonthly",
  "shortTermHoaMonthly",
  "shortTermOtherMonthlyFees",
  "shortTermMonthToMonthSurcharge",
  // How the applicant may pay the application fee, and what it asks them.
  "axisPaymentsEnabled",
  "applicationConfigMode",
  "customApplicationFields",
  "disabledStandardApplicationKeys",
  "shortTermApplicationConfigMode",
  "shortTermCustomApplicationFields",
  "shortTermDisabledStandardApplicationKeys",
  "propertyApplicationTemplates",
  "propertyApplicationTemplatesExplicit",
] as const satisfies readonly (keyof ManagerListingSubmissionV1)[];

/** Excludes `moveInInstructions` (door codes, key handoff) and proration internals. */
const PUBLIC_ROOM_KEYS = [
  "id",
  "name",
  "floor",
  "monthlyRent",
  "availability",
  "moveInAvailableDate",
  "detail",
  "furnishing",
  "roomAmenitiesText",
  "photoDataUrls",
  "videoDataUrl",
  "utilitiesEstimate",
  "utilitiesPaymentModel",
  // The per-room override is the public security deposit a prospect will be
  // charged. When it is absent, leasing falls back to the public listing-wide
  // deposit; omitting it here made those answers silently wrong on the shared
  // leasing line.
  "securityDeposit",
  "rentBasis",
  "dailyRentPrice",
  // A prospect must be able to see "1 of 2 beds available" on a shared room.
  "occupancyCapacity",
  // How many beds are actually in the room — a different question from how many
  // residents may hold a lease, and one a prospect sharing a room will ask.
  "bedCount",
  // PRP-329. Without these three the public payload silently keeps showing a
  // flexible room's stale `monthlyRent` as if it were the price. The AFFORDABILITY
  // RATIONALE behind flexible pricing is deliberately NOT projected — no sober-living
  // status, no resident means, no negotiated amount ever reaches a prospect.
  "pricingMode",
  "flexibleRentMin",
  "flexibleRentMax",
  // The rate card a prospect is choosing between. `weeklyRentPrice` without
  // `rentBasis` would never render, and the surcharge fields are what let a listing
  // say "+$150 on a short lease" instead of surprising them at the agreement.
  "weeklyRentPrice",
  "shortLeaseSurchargeMonthly",
  "shortLeaseMaxMonths",
  // Rent per resident on a shared room: the "from $800/mo" headline and each
  // slot's rent, utilities and deposit. WHO holds a slot lives on the application
  // and never reaches a prospect; the rows are re-picked to the money keys below.
  "residentPricing",
  "residentPrices",
] as const satisfies readonly (keyof ManagerRoomSubmission)[];

const PUBLIC_RESIDENT_PRICE_KEYS = [
  "monthlyRent",
  "utilitiesEstimate",
  "securityDeposit",
  "pricingMode",
] as const satisfies readonly (keyof ManagerRoomResidentPrice)[];

const PUBLIC_BATHROOM_KEYS = [
  "id",
  "name",
  "location",
  "amenitiesText",
  "photoDataUrls",
  "videoDataUrl",
  "shower",
  "toilet",
  "bathtub",
  "assignedRoomIds",
  "allResidents",
  // Read by `listing-bathroom-layout.ts` on the public detail page: without it a
  // bathroom the manager explicitly marked "hall" silently renders under the
  // derived "shared with A, B" heuristic instead. Carries no internal data.
  "accessKindByRoomId",
] as const satisfies readonly (keyof ManagerBathroomSubmission)[];

const PUBLIC_SHARED_SPACE_KEYS = [
  "id",
  "name",
  "spaceKind",
  "location",
  "detail",
  "amenitiesText",
  "photoDataUrls",
  "videoDataUrl",
  "roomAccessIds",
] as const satisfies readonly (keyof ManagerSharedSpaceSubmission)[];

const PUBLIC_BUNDLE_KEYS = [
  "id",
  "label",
  "price",
  "strikethrough",
  "promo",
  "roomsLine",
  "includedRoomIds",
  "shortTermEnabled",
  "shortTermNightlyRent",
] as const satisfies readonly (keyof ManagerBundleRow)[];

const PUBLIC_QUICK_FACT_KEYS = ["id", "label", "value"] as const satisfies readonly (keyof ManagerQuickFactRow)[];

const PUBLIC_CUSTOM_FEE_KEYS = [
  "id",
  "label",
  "amount",
  "frequency",
  // Prospect charges: without `presetId` a Pricing security-deposit row becomes
  // a generic house-wide "Security deposit" that overlay cannot replace, so a
  // leftover $100 listing-level amount shows next to the room's Pricing deposit.
  "presetId",
  "cadence",
  "roomIds",
  "leaseTypes",
  "shortTermAmount",
  // A fee scoped to a resident slot is a scope like `roomIds`, not an identity.
  "residentSlots",
] as const satisfies readonly (keyof ListingFeeRow)[];

const PUBLIC_HOUSE_DEFAULT_PRICE_KEYS = [
  "monthlyRent",
  "securityDeposit",
  "utilitiesEstimate",
  "shortTermRent",
  "shortTermDeposit",
  "weeklyRentPrice",
] as const satisfies readonly (keyof ListingHouseDefaults)[];

function moneyText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^\$/, "")
    .trim();
}

function uniqueMoney(values: readonly string[]): string[] {
  return [...new Set(values.map(moneyText).filter(Boolean))];
}

/**
 * Deposits a prospect should see come from the Pricing cards (Default room /
 * room records), never a leftover listing-level scalar. A $100 `securityDeposit`
 * next to rooms priced at $1,050 is the phantom house-wide line.
 */
function pricingDepositAmounts(
  sub: ManagerListingSubmissionV1,
  field: "securityDeposit" | "shortTermDeposit",
): string[] {
  const defaults = houseDefaultsForSubmission(sub);
  const fromRooms = uniqueMoney((sub.rooms ?? []).map((room) => moneyText(room[field])));
  if (fromRooms.length > 0) return fromRooms;
  const fromDefault = moneyText(defaults[field]);
  return fromDefault ? [fromDefault] : [];
}

function feeLooksLikeHouseWideDeposit(
  fee: Pick<ListingFeeRow, "presetId" | "label" | "roomIds">,
  kind: "security_deposit" | "short_term_deposit",
): boolean {
  if ((fee.roomIds ?? []).length > 0) return false;
  if (fee.presetId === kind) return true;
  const label = (fee.label ?? "").trim().toLowerCase();
  return kind === "security_deposit"
    ? label === "security deposit"
    : label === "short-term deposit" || label === "short term deposit";
}

/** Align listing-level charge scalars and house-wide fee rows with Pricing. */
function withPublicPricingCharges(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  const entireHome = isEntireHomeListing(sub);
  const longTerm = entireHome ? uniqueMoney([moneyText(sub.securityDeposit)]) : pricingDepositAmounts(sub, "securityDeposit");
  const shortTerm = pricingDepositAmounts(sub, "shortTermDeposit");
  const longTermHouseWide = longTerm.length === 1 ? longTerm[0]! : longTerm.length > 1 ? "" : moneyText(sub.securityDeposit);
  const shortTermHouseWide =
    shortTerm.length === 1 ? shortTerm[0]! : shortTerm.length > 1 ? "" : moneyText(sub.shortTermDeposit);

  const fees = sub.customFees;
  const nextFees =
    fees === undefined
      ? undefined
      : fees.flatMap((fee) => {
          const row = fee as ListingFeeRow;
          if (feeLooksLikeHouseWideDeposit(row, "security_deposit")) {
            if (!longTermHouseWide) return [];
            if (moneyText(row.amount) === longTermHouseWide) return [fee];
            return [{ ...fee, amount: longTermHouseWide }];
          }
          if (feeLooksLikeHouseWideDeposit(row, "short_term_deposit")) {
            if (!shortTermHouseWide) return [];
            if (moneyText(row.amount) === shortTermHouseWide) return [fee];
            return [{ ...fee, amount: shortTermHouseWide }];
          }
          return [fee];
        });

  return {
    ...sub,
    securityDeposit: longTermHouseWide,
    shortTermDeposit: shortTermHouseWide,
    ...(nextFees === undefined ? {} : { customFees: nextFees }),
  };
}

/** Copy only the named keys, and only when present, so absent stays absent. */
function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function pickRows<T extends object, K extends keyof T>(rows: unknown, keys: readonly K[]): Pick<T, K>[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is T => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => pick(row, keys));
}

function publicSubmission(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  const charged = withPublicPricingCharges(sub);
  const houseDefaults = charged.houseDefaults
    ? pick(charged.houseDefaults as ListingHouseDefaults, PUBLIC_HOUSE_DEFAULT_PRICE_KEYS)
    : undefined;
  return {
    ...pick(charged, PUBLIC_SUBMISSION_KEYS),
    ...(Array.isArray(charged.propertyApplicationTemplates)
      ? { propertyApplicationTemplates: charged.propertyApplicationTemplates.map(publicPropertyApplicationTemplate) }
      : {}),
    rooms: pickRows<ManagerRoomSubmission, (typeof PUBLIC_ROOM_KEYS)[number]>(charged.rooms, PUBLIC_ROOM_KEYS).map(
      (room) =>
        room.residentPrices === undefined
          ? room
          : {
              ...room,
              residentPrices: pickRows<ManagerRoomResidentPrice, (typeof PUBLIC_RESIDENT_PRICE_KEYS)[number]>(
                room.residentPrices,
                PUBLIC_RESIDENT_PRICE_KEYS,
              ) as ManagerRoomResidentPrice[],
            },
    ),
    bathrooms: pickRows<ManagerBathroomSubmission, (typeof PUBLIC_BATHROOM_KEYS)[number]>(
      charged.bathrooms,
      PUBLIC_BATHROOM_KEYS,
    ),
    sharedSpaces: pickRows<ManagerSharedSpaceSubmission, (typeof PUBLIC_SHARED_SPACE_KEYS)[number]>(
      charged.sharedSpaces,
      PUBLIC_SHARED_SPACE_KEYS,
    ),
    bundles: pickRows<ManagerBundleRow, (typeof PUBLIC_BUNDLE_KEYS)[number]>(charged.bundles, PUBLIC_BUNDLE_KEYS),
    quickFacts: pickRows<ManagerQuickFactRow, (typeof PUBLIC_QUICK_FACT_KEYS)[number]>(
      charged.quickFacts,
      PUBLIC_QUICK_FACT_KEYS,
    ),
    ...(Object.keys(houseDefaults ?? {}).length > 0 ? { houseDefaults } : {}),
    ...(charged.customFees === undefined
      ? {}
      : {
          customFees: pickRows<ListingFeeRow, (typeof PUBLIC_CUSTOM_FEE_KEYS)[number]>(
            charged.customFees,
            PUBLIC_CUSTOM_FEE_KEYS,
          ),
        }),
  } as ManagerListingSubmissionV1;
}

/**
 * Strip a stored listing down to what an anonymous prospect may see. Every
 * anonymous read of `manager_property_records.property_data` MUST run through
 * this — `getPublicListings()` here and the single-property lead route — or the
 * two disagree about what "public" means and the stricter one is decorative.
 */
export function publicListingProjection(property: MockProperty): MockProperty {
  const sub = property.listingSubmission;
  return {
    ...pick(property, PUBLIC_PROPERTY_KEYS),
    ...(sub && sub.v === 1 ? { listingSubmission: publicSubmission(sub) } : {}),
    // Says what this payload IS, so the browser cache it lands in can tell it
    // apart from the owner's authoritative copy of the same listing. See
    // `cachePublicExtraListings`.
    publicProjection: true,
  } as MockProperty;
}

/**
 * Public catalog of admin-approved live manager listings — the single source of
 * truth backing both `/api/property-records/public` (browser fetch) and the AI
 * housing-search tool (server-side, no HTTP round-trip). Keep both callers on
 * this function so "what the search sees" never drifts from "what the AI sees".
 */
export async function getPublicListings(opts?: { testWorkspaceId?: string | null }): Promise<MockProperty[]> {
  const db = createSupabaseServiceRoleClient();
  let query = db
    .from("manager_property_records")
    .select("id, manager_user_id, property_data")
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(500);
  query = opts?.testWorkspaceId
    ? query.eq("test_workspace_id", opts.testWorkspaceId)
    : query.is("test_workspace_id", null);
  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const production = isProductionRuntime();
  const managerIds = [
    ...new Set(
      (data ?? [])
        .map((row) => row.manager_user_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const managerEmailByUserId = new Map<string, string | null>();
  const managerProfileByUserId = new Map<string, ListingCtaManagerProfile>();
  // The public "Email" CTA target, resolved per owning manager. Only an address
  // that can actually receive comes back, so a listing never advertises a
  // mailbox that swallows a prospect's message.
  const managerWorkEmailByUserId = await resolveListingCtaEmailsByManager(db, managerIds);
  if (managerIds.length > 0) {
    const { data: profiles, error: profileError } = await db
      .from("profiles")
      .select("id, email, phone, phone_verified_at, sms_from_number")
      .in("id", managerIds);
    if (profileError) throw new Error(profileError.message);
    for (const profile of profiles ?? []) {
      managerEmailByUserId.set(profile.id, profile.email ?? null);
      managerProfileByUserId.set(profile.id, {
        phone: profile.phone ?? null,
        phone_verified_at: profile.phone_verified_at ?? null,
        sms_from_number: profile.sms_from_number ?? null,
      });
    }
  }

  const byKey = new Map<string, MockProperty>();
  for (const row of data ?? []) {
    const property = asProperty(row.property_data, row.id);
    if (!property) continue;
    // `status = live` is the source of truth in Supabase; older rows may omit the flag in JSON.
    const live = property.adminPublishLive === true ? property : { ...property, adminPublishLive: true as const };
    if (!isPropertyActiveForLeads(live)) continue;
    // Resolved from THIS row's owning manager, never a catalog-wide default, so
    // a multi-manager fleet cannot cross-route a prospect to the wrong phone.
    // Deliberately ignores any `contactSmsPhone` baked into the stored property
    // JSON — that blob is manager-editable and could point anywhere.
    const contactSmsPhone =
      resolveListingCtaSmsPhone(
        row.manager_user_id ? managerProfileByUserId.get(row.manager_user_id) ?? null : null,
      ) ?? undefined;
    const withOwner: MockProperty = {
      ...live,
      ...(row.manager_user_id && !live.managerUserId ? { managerUserId: row.manager_user_id } : {}),
      managerContactEmail: row.manager_user_id
        ? managerEmailByUserId.get(row.manager_user_id)?.trim() || undefined
        : undefined,
      // Always overwrite (never merely default) so an unresolved manager drops
      // the stored number rather than publishing a stale one. Same rule for the
      // work email: the stored blob is manager-editable and could name anything.
      contactSmsPhone,
      contactWorkEmail: row.manager_user_id
        ? managerWorkEmailByUserId.get(row.manager_user_id)
        : undefined,
    };
    const dedupeKey = `${withOwner.buildingName}::${withOwner.address}`.trim().toLowerCase();
    byKey.set(dedupeKey, withOwner);
  }

  const listings = [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
  // Project LAST, after every filter has had the full row to judge on, so a
  // future field added above this line cannot escape the allowlist.
  const visibleListings = opts?.testWorkspaceId
    ? listings
    : filterSandboxFromPublicCatalog(listings, { production, managerEmailByUserId });
  return visibleListings.map(
    publicListingProjection,
  );
}
