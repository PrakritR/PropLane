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
  ManagerCustomFeeRow,
  ManagerListingSubmissionV1,
  ManagerQuickFactRow,
  ManagerRoomSubmission,
  ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

function asProperty(value: unknown, id: string): MockProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = value as MockProperty;
  return { ...property, id: property.id?.trim() || id };
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
  // Marketing copy + media.
  "tagline",
  "petFriendly",
  "houseOverview",
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
  "zellePaymentsEnabled",
  "zelleContact",
  "venmoPaymentsEnabled",
  "venmoContact",
  "applicationFeeOtherEnabled",
  "applicationFeeOtherInstructions",
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
  "rentBasis",
  "dailyRentPrice",
  // A prospect must be able to see "1 of 2 beds available" on a shared room.
  "occupancyCapacity",
] as const satisfies readonly (keyof ManagerRoomSubmission)[];

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
] as const satisfies readonly (keyof ManagerCustomFeeRow)[];

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
  return {
    ...pick(sub, PUBLIC_SUBMISSION_KEYS),
    rooms: pickRows<ManagerRoomSubmission, (typeof PUBLIC_ROOM_KEYS)[number]>(sub.rooms, PUBLIC_ROOM_KEYS),
    bathrooms: pickRows<ManagerBathroomSubmission, (typeof PUBLIC_BATHROOM_KEYS)[number]>(
      sub.bathrooms,
      PUBLIC_BATHROOM_KEYS,
    ),
    sharedSpaces: pickRows<ManagerSharedSpaceSubmission, (typeof PUBLIC_SHARED_SPACE_KEYS)[number]>(
      sub.sharedSpaces,
      PUBLIC_SHARED_SPACE_KEYS,
    ),
    bundles: pickRows<ManagerBundleRow, (typeof PUBLIC_BUNDLE_KEYS)[number]>(sub.bundles, PUBLIC_BUNDLE_KEYS),
    quickFacts: pickRows<ManagerQuickFactRow, (typeof PUBLIC_QUICK_FACT_KEYS)[number]>(
      sub.quickFacts,
      PUBLIC_QUICK_FACT_KEYS,
    ),
    ...(sub.customFees === undefined
      ? {}
      : {
          customFees: pickRows<ManagerCustomFeeRow, (typeof PUBLIC_CUSTOM_FEE_KEYS)[number]>(
            sub.customFees,
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
export async function getPublicListings(): Promise<MockProperty[]> {
  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, property_data")
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(500);

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
      // the stored number rather than publishing a stale one.
      contactSmsPhone,
    };
    const dedupeKey = `${withOwner.buildingName}::${withOwner.address}`.trim().toLowerCase();
    byKey.set(dedupeKey, withOwner);
  }

  const listings = [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
  // Project LAST, after every filter has had the full row to judge on, so a
  // future field added above this line cannot escape the allowlist.
  return filterSandboxFromPublicCatalog(listings, { production, managerEmailByUserId }).map(
    publicListingProjection,
  );
}
