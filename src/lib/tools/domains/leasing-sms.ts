/**
 * Leasing SMS agent's capability surface: read live listings for THIS manager,
 * fetch room-level details, and mint apply/tour/listing URLs with prospect
 * prefills. escalate_to_manager is the only write (allowlisted) — it notifies
 * the owning manager; the model never sends SMS itself (delivery is code).
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { track } from "@/lib/analytics/posthog";
import {
  buildManagerApplyUrl,
  buildManagerListingUrl,
  buildManagerTourUrl,
  buildPropertyMessageHref,
} from "@/lib/manager-property-links";
import { residentPortalPath } from "@/lib/claw-resident-links";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { currentSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import { getPublicListings } from "@/lib/public-listings.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { availabilityLabelFromPublicSpans, pacificListingDay } from "@/lib/public-room-occupancy";
import {
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
} from "@/lib/manager-listing-submission";
import { listingOffersCustomLeaseSurcharge } from "@/lib/listing-fees";
import {
  roomDailyRentPrice,
  roomAdvertisedPriceLabel,
  roomIsDailyPriced,
  roomPricingIsFlexible,
} from "@/lib/room-pricing";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { getNearbyTransit, type TransitMode } from "@/lib/nearby-transit.server";
import { researchPropertyLocation } from "@/lib/property-location-research.server";
import { exactListingIdentityMatch, normalizeListingIdentity, normalizeListingWords } from "@/lib/listing-identity";
import { isStandaloneSmsAcknowledgment } from "@/lib/sms/standalone-acknowledgment";
import { updateAuditResult, writeAuditLog } from "../audit";

export const LEASING_ESCALATE_TOOL_NAME = "escalate_to_manager";
export const LEASING_SMS_SUPPRESS_TOOL_NAME = "suppress_redundant_reply";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Origin for links embedded in SMS. Carrier traffic always uses the canonical
 * production domain. An authenticated classified workspace test may use the
 * trusted deployment origin bound by its server route; arbitrary request hosts
 * and unclassified contexts never influence this value.
 */
export function publicOrigin(): string {
  const test = currentSmsTestTransport();
  if (test?.workspaceId && test.appOrigin) return test.appOrigin;
  return PRODUCTION_APP_ORIGIN;
}

export type RawPropertyRecord = {
  id: string;
  status: string | null;
  property_data: unknown;
  row_data: unknown;
};

function propertySource(rec: RawPropertyRecord): Record<string, unknown> | null {
  return asObject(rec.property_data) ?? asObject(rec.row_data);
}

function propertyLabel(src: Record<string, unknown> | null): string | null {
  return str(src, "buildingName") ?? str(src, "title") ?? str(src, "address") ?? str(src, "name");
}

/** Cap so a manager's whole marketing essay does not ride along on every list call. */
const MARKETING_NOTES_MAX_CHARS = 600;

/**
 * The manager's free-text marketing notes for the home (Promotion tab): the
 * Facebook / Craigslist ad title and copy, nicknames, landmarks. Read straight
 * off the stored submission — it is public listing metadata — so a prospect who
 * quotes the ad instead of the PropLane address still lands on the listing.
 */
function listingMarketingNotes(src: Record<string, unknown> | null): string | null {
  const subRaw = asObject(src?.listingSubmission as unknown);
  const notes = str(subRaw, "marketingNotes")?.trim();
  if (!notes) return null;
  return notes.length > MARKETING_NOTES_MAX_CHARS ? `${notes.slice(0, MARKETING_NOTES_MAX_CHARS)}…` : notes;
}

/**
 * The AI info tab's other sections — tours, house rules, pricing, neighborhood.
 * Assistant-only: they shape answers but are never quoted as listing copy.
 */
function listingAssistantInfo(src: Record<string, unknown> | null): Record<string, string> | null {
  const subRaw = asObject(src?.listingSubmission as unknown);
  const info = asObject(subRaw?.aiCommunicationInfo as unknown);
  if (!info) return null;
  const out: Record<string, string> = {};
  for (const key of ["tours", "rules", "pricing", "neighborhood"] as const) {
    const value = str(info, key)?.trim();
    if (value) out[key] = value.length > MARKETING_NOTES_MAX_CHARS ? `${value.slice(0, MARKETING_NOTES_MAX_CHARS)}…` : value;
  }
  return Object.keys(out).length ? out : null;
}

function summarizeRooms(src: Record<string, unknown> | null) {
  const subRaw = asObject(src?.listingSubmission as unknown);
  if (!subRaw) {
    return [] as Array<{
      id: string;
      name: string;
      floor: string | null;
      monthlyRent: number | null;
      rentBasis: "monthly" | "daily";
      dailyRentPrice: number | null;
      priceLabel: string | null;
      pricingMode: "fixed" | "flexible";
      publishedAvailability: string | null;
      currentAvailabilityVerified: false;
      furnishing: string | null;
      roomAmenities: string | null;
      detail: string | null;
      /** Maximum independent residents who may hold leases for this room. */
      residentCapacity: number;
      /** Physical beds described by the manager. This is not lease capacity. */
      physicalBeds: number | null;
      moveInAvailableDate: string | null;
      securityDeposit: string | null;
      utilitiesEstimate: string | null;
      utilitiesPaymentModel: string | null;
      shortLeaseSurchargeMonthly: string | null;
      shortLeaseMaxMonths: number | null;
    }>;
  }
  try {
    const sub = normalizeManagerListingSubmissionV1(subRaw as never);
    // A daily-priced room may leave monthlyRent at 0 — it still has a real price, so it
    // must survive the filter and carry its rate as a tool-grounded fact for the agent.
    return sub.rooms
      .filter((r) => r.name.trim() || r.monthlyRent > 0 || roomIsDailyPriced(r))
      .map((r, index) => ({
        id: r.id,
        name: r.name.trim() || `Room ${index + 1}`,
        floor: r.floor?.trim() || null,
        monthlyRent: r.monthlyRent > 0 ? r.monthlyRent : null,
        rentBasis: roomIsDailyPriced(r) ? ("daily" as const) : ("monthly" as const),
        dailyRentPrice: roomDailyRentPrice(r) ?? null,
        priceLabel: roomAdvertisedPriceLabel(r, "") || null,
        pricingMode: roomPricingIsFlexible(r) ? ("flexible" as const) : ("fixed" as const),
        publishedAvailability: str(r as unknown as Record<string, unknown>, "availability"),
        currentAvailabilityVerified: false as const,
        furnishing: r.furnishing?.trim() || null,
        roomAmenities: r.roomAmenitiesText?.trim() || null,
        detail: str(r as unknown as Record<string, unknown>, "detail"),
        residentCapacity: normalizeRoomOccupancyCapacity(r.occupancyCapacity),
        physicalBeds: r.bedCount ?? null,
        moveInAvailableDate: r.moveInAvailableDate?.trim() || null,
        securityDeposit: r.securityDeposit?.trim() || null,
        utilitiesEstimate: r.utilitiesEstimate?.trim() || null,
        utilitiesPaymentModel: r.utilitiesPaymentModel?.trim() || null,
        shortLeaseSurchargeMonthly: r.shortLeaseSurchargeMonthly?.trim() || null,
        shortLeaseMaxMonths: typeof r.shortLeaseMaxMonths === "number" ? r.shortLeaseMaxMonths : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Prospect-safe facts that do not fit in a browse-card summary. Keep this
 * deliberately narrow: the leasing agent may receive only published pricing
 * and policy facts, never the listing submission blob.
 */
function leasingListingFacts(src: Record<string, unknown> | null, rooms: ReturnType<typeof summarizeRooms>) {
  const subRaw = asObject(src?.listingSubmission);
  let submission: ReturnType<typeof normalizeManagerListingSubmissionV1> | null = null;
  if (subRaw) {
    try {
      submission = normalizeManagerListingSubmissionV1(subRaw as never);
    } catch {
      // A malformed legacy submission is unknown rather than a reason to
      // expose its raw fields or to make up a policy.
    }
  }

  // Do not normalize this boolean: normalization defaults an absent value to
  // false, which would turn an unknown pet policy into "no pets".
  const submissionPetFriendly = typeof subRaw?.petFriendly === "boolean" ? subRaw.petFriendly : null;
  const petFriendly = typeof src?.petFriendly === "boolean" ? src.petFriendly : submissionPetFriendly;
  // Resolve only a normalized submission. `resolveAllowedLeaseTerms` expects
  // array/string values, so passing a malformed stored blob through would turn
  // bad data into a tool failure instead of an honest unknown.
  const availableTerms = submission ? resolveAllowedLeaseTerms(submission) : [];

  const listingDeposit = submission?.securityDeposit.trim() || null;

  return {
    petFriendly,
    leaseTerms: {
      available: availableTerms,
      publishedDescription: submission?.leaseTermsBody.trim() || null,
      // Rates are deliberately unassociated with lease terms. The schema has
      // no general term-to-price table, and repeating a monthly room price on a
      // Short-Term Stay or Airbnb row would be a false quote.
      baseRoomPrices: rooms.map((room) => ({
        name: room.name,
        priceLabel: room.priceLabel,
        pricingMode: room.pricingMode,
        shortLeaseSurchargeMonthly: room.shortLeaseSurchargeMonthly,
        shortLeaseMaxMonths: room.shortLeaseMaxMonths,
      })),
      termSurcharges: [
        {
          term: "Month-to-Month",
          offered: availableTerms.includes("Month-to-Month"),
          monthlySurcharge: null,
        },
      ],
      customCalendarSurcharge: {
        eligible: submission ? listingOffersCustomLeaseSurcharge(submission) : false,
        monthlySurcharge: submission?.customLeaseSurcharge?.trim() || null,
        appliesOnlyWhen: "The selected standard lease dates use a non-standard calendar term.",
      },
    },
    securityDeposit: {
      listingAmount: listingDeposit,
      rooms: rooms.map((room) => {
        const roomAmount = room.securityDeposit;
        return {
          name: room.name,
          overrideAmount: roomAmount,
          // This is selection, not arithmetic. It matches the standard-lease
          // room-first rule, including an explicit "0" override. Short-term
          // deposits have different rules and are intentionally not implied.
          standardLeaseEffectiveAmount: roomAmount ?? listingDeposit,
        };
      }),
    },
    utilities: {
      costNotes: submission?.houseCostsDetail.trim() || null,
      rooms: rooms.map((room) => ({
        name: room.name,
        estimate: room.utilitiesEstimate,
        paymentModel: room.utilitiesPaymentModel,
      })),
      entireHome: submission
        ? {
            estimate: submission.entireHomeUtilitiesEstimate?.trim() || null,
            paymentModel: submission.entireHomeUtilitiesPaymentModel?.trim() || null,
          }
        : null,
    },
  };
}

function summarizeBundles(src: Record<string, unknown> | null) {
  const subRaw = asObject(src?.listingSubmission as unknown);
  if (!subRaw) return [] as Array<{ id: string; label: string; price: string | null }>;
  try {
    const sub = normalizeManagerListingSubmissionV1(subRaw as never);
    return (sub.bundles ?? [])
      .filter((b) => (b.id ?? "").trim() && (b.label ?? "").trim())
      .map((b) => ({
        id: String(b.id).trim(),
        label: String(b.label).trim(),
        price: b.price?.trim() || null,
      }));
  } catch {
    return [];
  }
}

async function loadOwnedLiveListings(ctx: AgentContext): Promise<RawPropertyRecord[]> {
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, status, property_data, row_data")
    .eq("manager_user_id", ctx.landlordId)
    .in("status", ["live", "listed"])
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as RawPropertyRecord[];
}

async function loadOwnedListing(
  ctx: AgentContext,
  propertyId: string,
): Promise<RawPropertyRecord | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, status, property_data, row_data")
    .eq("id", id)
    .eq("manager_user_id", ctx.landlordId)
    .in("status", ["live", "listed"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RawPropertyRecord | null) ?? null;
}

/** Authorize a link with the same live-listing resolution as details, without reading occupancy. */
export async function resolveLiveListingForSms(ctx: AgentContext, propertyId: string): Promise<string | null> {
  return (await loadResolvableListing(ctx, propertyId))?.id ?? null;
}

// Public occupancy already has a CDN cache. SMS detail reads share a short,
// owner-scoped in-process cache so follow-up turns do not rescan a portfolio.
const SMS_OCCUPANCY_TTL_MS = 30_000;
const smsOccupancyCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof loadPublicRoomOccupancy>> }>();
const smsOccupancyInflight = new Map<string, Promise<Awaited<ReturnType<typeof loadPublicRoomOccupancy>>>>();

async function loadListingOccupancyForSms(rec: RawPropertyRecord, submission: Record<string, unknown>, ownerId?: string) {
  const key = `${ownerId ?? "public"}::${rec.id}`;
  const cached = smsOccupancyCache.get(key);
  if (cached && Date.now() - cached.at < SMS_OCCUPANCY_TTL_MS) return cached.rows;
  const inflight = smsOccupancyInflight.get(key);
  if (inflight) return inflight;
  const pending = loadPublicRoomOccupancy(
    createSupabaseServiceRoleClient(),
    [{ id: rec.id, listingSubmission: submission as never }],
    ownerId,
  ).then((rows) => {
    if (smsOccupancyCache.size >= 100) smsOccupancyCache.clear();
    smsOccupancyCache.set(key, { at: Date.now(), rows });
    return rows;
  }).finally(() => smsOccupancyInflight.delete(key));
  smsOccupancyInflight.set(key, pending);
  return pending;
}

/** Test-only: discard occupancy snapshots between fixtures. */
export function __resetSmsOccupancyCache(): void {
  smsOccupancyCache.clear();
  smsOccupancyInflight.clear();
}

/**
 * A public-catalog listing (any owner) reshaped into the raw-row form the
 * summarizers expect. `getPublicListings()` already returns the marketing
 * `property_data` (title/address/rooms/bundles via `listingSubmission`), so no
 * second query is needed — and it is exactly the admin-approved, non-sandbox,
 * live set the public `/rent` pages render, never private/financial data.
 */
function mockPropertyToRecord(p: {
  id: string;
  [k: string]: unknown;
}): RawPropertyRecord {
  return {
    id: p.id,
    status: "live",
    property_data: p as unknown as Record<string, unknown>,
    row_data: null,
  };
}

/* Short in-process memo so one agent turn (list → details → links = 3 tool
 * calls) doesn't refetch the whole public catalog 3× — egress guard per
 * AGENTS.md. Single in-flight promise coalesces concurrent calls. */
const CATALOG_TTL_MS = 30_000;
const catalogCache = new Map<string, { at: number; rows: RawPropertyRecord[] }>();
const catalogInflight = new Map<string, Promise<RawPropertyRecord[]>>();

async function loadPublicCatalogRows(testWorkspaceId?: string): Promise<RawPropertyRecord[]> {
  const key = testWorkspaceId ?? "public";
  const now = Date.now();
  const cached = catalogCache.get(key);
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.rows;
  const inflight = catalogInflight.get(key);
  if (inflight) return inflight;
  const pending = (async () => {
    try {
      const listings = await getPublicListings(testWorkspaceId ? { testWorkspaceId } : undefined);
      const rows = listings.map(mockPropertyToRecord);
      catalogCache.set(key, { at: Date.now(), rows });
      return rows;
    } finally {
      catalogInflight.delete(key);
    }
  })();
  catalogInflight.set(key, pending);
  return pending;
}

/** Test-only: drop the catalog memo so fixtures aren't shadowed across tests. */
export function __resetLeasingCatalogCache(): void {
  catalogCache.clear();
  catalogInflight.clear();
}

function isCrossCatalog(ctx: AgentContext): boolean {
  return ctx.leasingScope?.crossCatalog === true;
}

/**
 * Listings the agent may browse this turn: the whole public catalog on the
 * shared line (any owner), else only this manager's own live/listed listings.
 */
async function loadBrowsableListings(ctx: AgentContext): Promise<RawPropertyRecord[]> {
  if (isCrossCatalog(ctx)) return loadPublicCatalogRows();
  const owned = await loadOwnedLiveListings(ctx);
  if (!ctx.listingPublicOnly) return owned;
  const publicById = new Map((await loadPublicCatalogRows(currentSmsTestTransport()?.workspaceId ?? undefined)).map((row) => [row.id, row]));
  return owned.flatMap((row) => {
    const projected = publicById.get(row.id);
    return projected ? [projected] : [];
  });
}

/**
 * Resolve one listing by id. Always tries the manager's own listings first (so a
 * per-manager line and a manager testing their own not-yet-fully-live listing
 * keep working); on the shared line, falls back to any public-catalog listing.
 */
async function loadResolvableListing(
  ctx: AgentContext,
  propertyId: string,
): Promise<RawPropertyRecord | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const owned = await loadOwnedListing(ctx, id);
  if (owned) {
    if (!ctx.listingPublicOnly) return owned;
    const publicRows = await loadPublicCatalogRows(currentSmsTestTransport()?.workspaceId ?? undefined);
    return publicRows.find((row) => row.id === owned.id) ?? null;
  }
  if (!isCrossCatalog(ctx)) return null;
  const rows = await loadPublicCatalogRows();
  return rows.find((r) => r.id === id) ?? null;
}

/** Pure list-item shape for one listing — exported for tests. */
export function summarizeListingRecord(rec: RawPropertyRecord) {
  const src = propertySource(rec);
  const rooms = summarizeRooms(src);
  let alsoListedAs = str(src, "alsoListedAs") ?? "";
  let tagline = str(src, "tagline") ?? "";
  let petFriendly: boolean | null =
    typeof src?.petFriendly === "boolean" ? src.petFriendly : null;
  const subRaw = asObject(src?.listingSubmission as unknown);
  if (subRaw) {
    try {
      const sub = normalizeManagerListingSubmissionV1(subRaw as never);
      if (!alsoListedAs && sub.alsoListedAs.trim()) alsoListedAs = sub.alsoListedAs.trim();
      if (!tagline && sub.tagline.trim()) tagline = sub.tagline.trim();
      if (petFriendly === null && typeof subRaw.petFriendly === "boolean") petFriendly = subRaw.petFriendly;
    } catch {
      /* keep top-level fields */
    }
  }
  return {
    propertyId: rec.id,
    status: rec.status,
    title: propertyLabel(src),
    address: str(src, "address"),
    neighborhood: str(src, "neighborhood"),
    rentLabel: str(src, "rentLabel"),
    // The aggregate card label can disagree with an individual room. The
    // stored room label is published information, not a current occupancy check.
    tagline: tagline || null,
    alsoListedAs: alsoListedAs || null,
    petFriendly,
    beds: typeof src?.beds === "number" ? src.beds : null,
    baths: typeof src?.baths === "number" ? src.baths : null,
    marketingNotes: listingMarketingNotes(src),
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      monthlyRent: r.monthlyRent,
      rentBasis: r.rentBasis,
      dailyRentPrice: r.dailyRentPrice,
      priceLabel: r.priceLabel,
      publishedAvailability: r.publishedAvailability,
      currentAvailabilityVerified: r.currentAvailabilityVerified,
      furnishing: r.furnishing,
      residentCapacity: r.residentCapacity,
      physicalBeds: r.physicalBeds,
    })),
    bundles: summarizeBundles(src),
  };
}

const LISTING_MATCH_STOPWORDS = new Set([
  "the",
  "and",
  "near",
  "for",
  "with",
  "from",
  "room",
  "rooms",
  "private",
  "shared",
  "home",
  "house",
  "apt",
  "apartment",
  "unit",
  "bed",
  "bedroom",
]);

/** Significant tokens for fuzzy ad-title matching (PRP-426). */
export function listingSummarySignificantTokens(text: string): string[] {
  return normalizeListingWords(text)
    .filter((w) => w.length > 2 && !LISTING_MATCH_STOPWORDS.has(w));
}

function listingIdentityFields(summary: ReturnType<typeof summarizeListingRecord>): (string | null)[] {
  return [summary.title, summary.address, summary.alsoListedAs, ...summary.rooms.map((room) => room.name)];
}

/** Exact normalized identities outrank fuzzy marketing-token matches. */
export function listingSummaryMatchRank(
  summary: ReturnType<typeof summarizeListingRecord>,
  needle: string,
): number {
  const value = needle.trim();
  if (!value) return 1;
  if (exactListingIdentityMatch(value, listingIdentityFields(summary))) return 4;
  const compactNeedle = normalizeListingIdentity(value);
  const compactIdentities = listingIdentityFields(summary).map((field) => normalizeListingIdentity(field ?? ""));
  if (compactNeedle && compactIdentities.some((field) => field.includes(compactNeedle))) return 3;
  return listingSummaryMatches(summary, value) ? 2 : 0;
}

/** True when a listing summary matches a free-text needle (address/name/room/ad title). */
export function listingSummaryMatches(
  summary: ReturnType<typeof summarizeListingRecord>,
  needle: string,
): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  const hay = [
    summary.title,
    summary.address,
    summary.neighborhood,
    summary.tagline,
    summary.alsoListedAs,
    summary.marketingNotes,
    ...summary.rooms.map((r) => r.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (hay.includes(n)) return true;
  // Require every significant token (len > 2) so "8th Ave" does not also
  // match every other "… Ave …" listing.
  const words = n.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 0 && words.every((w) => hay.includes(w))) return true;
  // Ad / marketing titles: ≥2 significant tokens overlap (e.g. Facebook
  // "Private locked room near University of Washington" vs alsoListedAs).
  const needleTokens = listingSummarySignificantTokens(n);
  if (needleTokens.length < 2) return false;
  const hayTokenList = listingSummarySignificantTokens(hay);
  const hayTokens = new Set(hayTokenList);
  let hits = 0;
  for (const token of needleTokens) {
    if (hayTokens.has(token)) {
      hits += 1;
      continue;
    }
    if (hayTokenList.some((h) => h.includes(token) || token.includes(h))) {
      hits += 1;
    }
  }
  return hits >= 2;
}

export const listLiveListingsTool = defineTool({
  name: "list_live_listings",
  description:
    "Search PropLane's live public listings — on the shared PropLane line this spans EVERY manager's listings (the same catalog as the public /rent site), so use it to find ANY house or room a prospect names. Joined/spaced names, case, Unicode, and punctuation are normalized; exact identity ranks before fuzzy marketing terms. The resolution field says exact, ranked, ambiguous, none, or browsing. Ask a short clarifying question for ambiguous results. Returns canonical property and room ids plus public facts. Use first when matching a prospect's house or room question.",
  kind: "read",
  inputSchema: z
    .object({
      query: z
        .string()
        .optional()
        .describe("Optional free-text filter (address fragment, house name, room name, or the title of an ad the prospect saw)."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const needle = (input.query ?? "").trim();
    const rows = await loadBrowsableListings(ctx);
    const ranked = rows
      .map(summarizeListingRecord)
      .map((listing) => ({ listing, rank: listingSummaryMatchRank(listing, needle) }))
      .filter(({ rank }) => rank > 0)
      .sort((a, b) => b.rank - a.rank);
    const bestRank = ranked[0]?.rank ?? 0;
    const bestCount = ranked.filter(({ rank }) => rank === bestRank).length;
    const listings = ranked
      .map(({ listing }) => listing)
      // Cap the payload the model sees (large catalogs); a needle narrows first.
      .slice(0, 40);
    return {
      count: listings.length,
      listings,
      resolution: !needle
        ? "browsing"
        : listings.length === 0
          ? "none"
          : bestCount > 1
            ? "ambiguous"
            : bestRank === 4
              ? "exact"
              : "ranked",
    };
  },
});

export const suppressRedundantLeasingReplyTool = defineTool({
  name: LEASING_SMS_SUPPRESS_TOOL_NAME,
  description:
    "Stay silent only when the newest inbound is a standalone acknowledgment to a confirmed recently delivered SMS. Repeated questions, explicit repeat or clarification requests, corrections, new facts, availability questions, and failed or unknown deliveries must receive an answer. Copy the recent delivered message id exactly.",
  inputSchema: z.object({
    recentOutboundMessageId: z.string().min(1),
    reason: z.literal("acknowledgment"),
  }).strict(),
  handler: async (ctx, input) => {
    const matched = ctx.leasingScope?.recentDeliveredReplies?.find(
      (reply) => reply.messageId === input.recentOutboundMessageId,
    );
    if (!matched) {
      throw new Error("That message is not a confirmed recent delivered reply. Answer the prospect normally.");
    }
    if (!isStandaloneSmsAcknowledgment(ctx.leasingScope?.currentInboundText ?? "")) {
      throw new Error("The current inbound is not a standalone acknowledgment. Answer the prospect normally.");
    }
    return { suppress: true as const, referenceMessageId: matched.messageId, reason: input.reason };
  },
});

export const getListingDetailsTool = defineTool({
  name: "get_listing_details",
  description:
    "Full prospect-safe details for one live listing: address, rooms and their published prices, verified current availability when the occupancy read succeeds, furnishing and amenities, available lease terms, nullable pet policy, deposits, and utilities. A failed occupancy read leaves current availability unknown. Call before answering specifics about a house or room.",
  kind: "read",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("Listing / property id from list_live_listings."),
      roomQuery: z
        .string()
        .optional()
        .describe("Optional room name fragment to highlight matching rooms."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rec = await loadResolvableListing(ctx, input.propertyId);
    if (!rec) return { found: false };
    const src = propertySource(rec);
    const rooms = summarizeRooms(src);
    let occupancy: Awaited<ReturnType<typeof loadPublicRoomOccupancy>> | null = null;
    try {
      const submission = asObject(src?.listingSubmission);
      if (submission?.v === 1) {
        occupancy = await loadListingOccupancyForSms(rec, submission, isCrossCatalog(ctx) ? undefined : ctx.landlordId);
      }
    } catch {
      // A failed read cannot turn a saved label into verified current availability.
    }
    const occupancyByRoom = new Map(occupancy?.map((row) => [row.roomChoice, row.spans]) ?? []);
    const roomCapacity = new Map<string, unknown>();
    const submission = asObject(src?.listingSubmission);
    for (const room of Array.isArray(submission?.rooms) ? submission.rooms : []) {
      const record = asObject(room);
      if (record && typeof record.id === "string") roomCapacity.set(record.id, record.occupancyCapacity);
    }
    const facts = leasingListingFacts(src, rooms);
    // Capacities are normalized at the listing boundary. Do not derive this
    // from physical beds or bedrooms: a room's published resident capacity is
    // an independent listing fact, not a legal occupancy limit. If any stored
    // room was excluded from the prospect-safe room summary, the visible rows
    // cannot support a complete listing total, so return unknown.
    let maximumResidents: number | null = null;
    try {
      const normalizedRooms = submission
        ? normalizeManagerListingSubmissionV1(submission as never).rooms
        : [];
      const completeRoomSet = normalizedRooms.length === rooms.length && normalizedRooms.every(
        (room, index) => room.id === rooms[index]?.id,
      );
      if (completeRoomSet && rooms.length > 0) {
        maximumResidents = rooms.reduce((total, room) => total + room.residentCapacity, 0);
      }
    } catch {
      // Malformed legacy room data cannot support a complete listing total.
    }
    const roomNeedle = (input.roomQuery ?? "").trim().toLowerCase();
    const matchedRooms = roomNeedle
      ? rooms.filter(
          (r) =>
            r.name.toLowerCase().includes(roomNeedle) ||
            roomNeedle.includes(r.name.toLowerCase()) ||
            (r.floor ?? "").toLowerCase().includes(roomNeedle),
        )
      : rooms;
    return {
      found: true,
      listing: {
        propertyId: rec.id,
        title: propertyLabel(src),
        address: str(src, "address"),
        neighborhood: str(src, "neighborhood"),
        rentLabel: str(src, "rentLabel"),
        beds: typeof src?.beds === "number" ? src.beds : null,
        baths: typeof src?.baths === "number" ? src.baths : null,
        tagline: str(src, "tagline"),
        marketingNotes: listingMarketingNotes(src),
        assistantInfo: listingAssistantInfo(src),
        alsoListedAs: str(src, "alsoListedAs"),
        petFriendly: facts.petFriendly,
        description: str(src, "description")?.slice(0, 800) ?? null,
        rooms: matchedRooms.map((room) => {
          const spans = occupancyByRoom.get(`${rec.id}::${room.id}`);
          return {
            ...room,
            currentAvailability: spans
              ? availabilityLabelFromPublicSpans(spans, roomCapacity.get(room.id), pacificListingDay())
              : null,
            currentAvailabilityVerified: spans !== undefined,
          };
        }),
        allRoomCount: rooms.length,
        maximumResidents,
        bundles: summarizeBundles(src),
        leaseTerms: facts.leaseTerms,
        securityDeposit: facts.securityDeposit,
        utilities: facts.utilities,
      },
    };
  },
});

export const getNearbyTransitTool = defineTool({
  name: "get_nearby_transit",
  description: "Look up named nearby mapped transit stops for one resolved listing. Distances are approximate straight-line distances from verified listing coordinates and are sourced from OpenStreetMap. Walking time and service frequency are unavailable.",
  kind: "read",
  inputSchema: z.object({
    propertyId: z.string().min(1).describe("Listing / property id returned by list_live_listings."),
    mode: z.enum(["bart", "bus", "public_transit"]).optional(),
  }).strict(),
  handler: async (ctx, input) => {
    const rec = await loadResolvableListing(ctx, input.propertyId);
    if (!rec) return { found: false, error: "listing_not_found" };
    const result = await getNearbyTransit(propertySource(rec) ?? {}, (input.mode ?? "public_transit") as TransitMode);
    return { found: true, ...result };
  },
});

export const getPropertyLocationResearchTool = defineTool({
  name: "research_property_location",
  description: "Research sourced public facts about schools, parks, groceries, operational transit, or nearby amenities for one resolved live listing. Use schools_dual_language for dual-language or immersion program questions, and transit_stops for mapped stop locations. Results include source links and limitations; they do not establish school eligibility, walk time, rankings, or suitability.",
  kind: "read",
  inputSchema: z.object({
    propertyId: z.string().min(1).describe("Listing / property id returned by list_live_listings."),
    topic: z.enum(["schools", "schools_dual_language", "parks", "groceries", "transit_service", "transit_stops", "nearby_amenities"]),
  }).strict(),
  handler: async (ctx, input) => {
    const rec = await loadResolvableListing(ctx, input.propertyId);
    if (!rec) return { found: false, error: "listing_not_found" };
    const src = propertySource(rec) ?? {};
    // Only public location fields are allowed across the search boundary. In
    // particular, never forward listingSubmission, notes, contacts, or row data.
    const location: Record<string, unknown> = {};
    for (const key of ["address", "neighborhood", "city", "state", "zip", "mapLat", "mapLng"] as const) {
      const value = src[key];
      if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value))) {
        location[key] = value;
      }
    }
    if (!location.address && !location.zip && !location.neighborhood && !location.city) {
      return { found: true, available: false, reason: "location_unavailable" };
    }
    const result = await researchPropertyLocation({
      scopeKey: `leasing:${rec.id}`,
      propertyId: rec.id,
      location,
      topic: input.topic,
    });
    return { ...result, found: true };
  },
});

export const buildProspectLinksTool = defineTool({
  name: "build_prospect_links",
  description:
    "Build the listing, tour, apply, message, and browse URLs for a matched property (any live PropLane listing on the shared line). Call it as soon as a listing is matched, then send the link that answers the request: listingUrl for any question about the home (rent, rooms, availability, photos, video, amenities, requirements), tourUrl when they want to tour or see it in person, applyUrl when they want to apply or ask what is needed to rent, messageUrl to leave a longer note for the manager. Apply links prefill the prospect's phone and optional room/bundle so the form is already filled. Use the tool-returned origin: production for carrier SMS and the authorized deployment for an authenticated private-workspace SMS test.",
  kind: "read",
  inputSchema: z
    .object({
      propertyId: z.string().min(1),
      listingRoomId: z.string().optional(),
      roomName: z.string().optional(),
      bundleId: z.string().optional(),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rec = await loadResolvableListing(ctx, input.propertyId);
    if (!rec) return { ok: false, error: "listing_not_found" };
    // Minting links for a house is the agent committing to it: tag the thread
    // so the teammates who hold that house can see it. Owned listings only —
    // `loadOwnedListing` is what resolved, or it is another manager's catalog.
    if (ctx.leasingScope && (await loadOwnedListing(ctx, input.propertyId))) {
      const { tagProspectThreadFromAgent } = await import("@/lib/sms/conversation-houses.server");
      await tagProspectThreadFromAgent(ctx.db, {
        landlordId: ctx.landlordId,
        prospectPhoneE164: ctx.leasingScope.prospectPhoneE164,
        channel: ctx.leasingScope.channel ?? "sms",
        propertyId: input.propertyId,
        propertyOwnerUserId: ctx.landlordId,
        source: "leasing",
      });
    }
    const src = propertySource(rec);
    const rooms = summarizeRooms(src);
    let listingRoomId = input.listingRoomId?.trim() || "";
    let roomName = input.roomName?.trim() || "";
    if (!listingRoomId && roomName) {
      const hit = rooms.find(
        (r) =>
          r.name.toLowerCase() === roomName.toLowerCase() ||
          r.name.toLowerCase().includes(roomName.toLowerCase()),
      );
      if (hit) {
        listingRoomId = hit.id;
        roomName = hit.name;
      }
    }
    if (listingRoomId && !roomName) {
      roomName = rooms.find((r) => r.id === listingRoomId)?.name ?? roomName;
    }
    const origin = publicOrigin();
    const prospectPhone = ctx.leasingScope?.prospectPhoneE164 ?? null;
    const applyUrl = buildManagerApplyUrl(origin, {
      propertyId: rec.id,
      listingRoomId: listingRoomId || undefined,
      roomName: roomName || undefined,
      bundleId: input.bundleId?.trim() || undefined,
      phone: prospectPhone || undefined,
    });
    return {
      ok: true,
      propertyId: rec.id,
      title: propertyLabel(src),
      /** Full listing page: photos, video, rooms, rent, policies. Send for any question about the home. */
      listingUrl: buildManagerListingUrl(origin, rec.id),
      /** Prospect picks a real open time; the manager confirms. Send when they want to tour. */
      tourUrl: buildManagerTourUrl(origin, rec.id),
      /** Prefilled rental application. Send when they want to apply or ask what is needed to rent. */
      applyUrl,
      /** Leave a longer message about this home for the manager. */
      messageUrl: `${origin}${buildPropertyMessageHref(rec.id)}`,
      /** Every live home on PropLane. */
      browseUrl: `${origin}/rent/browse`,
      prefilled: {
        phone: prospectPhone,
        listingRoomId: listingRoomId || null,
        roomName: roomName || null,
        bundleId: input.bundleId?.trim() || null,
      },
    };
  },
});

/**
 * Canonical, origin-correct PropLane links for the general handoffs a prospect
 * asks about (browse all homes, start an application, book a tour, pricing,
 * resident portal to sign a lease). Pure URL builder — no DB, no scope — so the
 * agent never has to invent a URL. Carrier turns use production; authenticated
 * private-workspace tests may use their authorized deployment origin. Use for
 * "how do I apply / where do I see all listings / how do I sign my lease" when
 * no specific property is matched yet.
 */
export function proplaneSiteLinks(origin: string) {
  const base = origin.replace(/\/$/, "");
  return {
    origin: base,
    browseHomes: `${base}/rent/browse`,
    startApplication: `${base}/rent/apply`,
    pricing: `${base}/pricing`,
    demo: `${base}/demo`,
    docs: `${base}/docs`,
    residentPortal: `${base}${residentPortalPath("login")}`,
    residentSignup: `${base}${residentPortalPath("signup")}`,
    signLease: `${base}${residentPortalPath("lease")}`,
    payRent: `${base}${residentPortalPath("payments")}`,
  };
}

export const getSiteLinksTool = defineTool({
  name: "get_site_links",
  description:
    "Canonical PropLane site links for the current authorized deployment (production for carrier SMS; the authenticated private-workspace deployment for an SMS test): browse all homes, start an application, pricing, the live demo, and the resident portal for signing in, signing a lease, or paying rent. Use when a prospect asks a general 'where do I …' question and no single property is matched, or when a current resident texts the leasing line about paying or their lease. For a specific matched listing use build_prospect_links instead.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async () => {
    return { links: proplaneSiteLinks(publicOrigin()) };
  },
});

export const escalateLeasingToManagerTool = defineWriteTool({
  name: LEASING_ESCALATE_TOOL_NAME,
  description:
    "Notify the property manager when you cannot answer from listing tools or the prospect needs a human decision. Call at most once per issue, then tell the prospect the manager will follow up.",
  inputSchema: z
    .object({
      summary: z
        .string()
        .min(1)
        .max(500)
        .describe("One or two factual sentences describing what the prospect needs."),
      handoff: z
        .enum(["quiet"])
        .optional()
        .describe("Use quiet only when a delivered manager handoff is the only useful next step for this SMS prospect."),
    })
    .strict(),
  // Allow-listed on the SMS surface (no human is present on a webhook turn);
  // the preview keeps it previewable anywhere it is not allow-listed.
  preview: async (ctx, input) => ({
    kind: LEASING_ESCALATE_TOOL_NAME,
    title: "Notify the manager",
    summary: "Send the manager a note that this prospect needs a human follow-up.",
    fields: [{ label: "Summary", value: input.summary }],
    confirmLabel: "Notify manager",
  }),
  handler: async (ctx, input) => {
    const scope = ctx.leasingScope;
    if (!scope) return { ok: false, retrySafe: true, sideEffects: "none", error: "No leasing conversation bound." };

    const hourBucket = new Date().toISOString().slice(0, 13);
    const dedupeKey = `leasing_sms_escalate:${scope.sessionId}:${hourBucket}`;
    const audit = await writeAuditLog(ctx, {
      action: "leasing_sms_escalate",
      toolName: LEASING_ESCALATE_TOOL_NAME,
      inputSummary: { sessionId: scope.sessionId, channel: scope.channel ?? "sms" },
      resultSummary: { deliveryStatus: "pending" },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (!audit.duplicate) return { ok: false, retrySafe: true, sideEffects: "none", error: "Could not record the escalation." };
      const { data: prior } = await ctx.db
        .from("audit_log")
        .select("result_summary")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();
      const summary = prior?.result_summary as { deliveryStatus?: string } | null;
      if (summary?.deliveryStatus === "delivered") {
        return {
          ok: true,
          alreadyEscalated: true,
          message: "The manager was already notified about this a moment ago.",
        };
      }
      if (summary?.deliveryStatus === "suppressed") {
        return {
          ok: false,
          suppressed: true,
          error: "The manager has disabled these notifications.",
        };
      }
      // A legacy/pending audit row is not proof that notification succeeded.
      // Fail closed to unknown so concurrent retries cannot double-notify.
      return { ok: false, deliveryUnknown: true, error: "The manager notification outcome is not confirmed." };
    }
    /* Name the channel the prospect actually used. Telling a manager someone
       "texted your work number ()" — with an empty phone — is worse than no
       notice at all: it points them at the wrong place to reply. */
    const emailedIn = scope.channel === "email";
    const contact = emailedIn
      ? scope.prospectEmail?.trim() || "an unknown address"
      : scope.prospectPhoneE164;
    let notification: Awaited<ReturnType<typeof notifyManagerFromAgent>>;
    try {
      notification = await notifyManagerFromAgent(ctx.db, {
        landlordId: ctx.landlordId,
        subject: emailedIn ? "Leasing email needs you" : "Leasing text needs you",
        text: [
          emailedIn
            ? `A prospect emailed your work address (${contact}):`
            : `A prospect texted your work number (${contact}):`,
          "",
          input.summary,
          "",
          emailedIn
            ? "Open Communication to reply."
            : "Open Communication → SMS to reply from your work number.",
        ].join("\n"),
        threadType: "leasing_sms_escalation",
        url: emailedIn ? "/portal/communication" : "/portal/communication/sms",
        notify: { push: true, sms: true },
        idempotencyKey: dedupeKey,
      });
      if (!notification.delivered) {
        const deliveryStatus = notification.suppressed ? "suppressed" : "unknown";
        await updateAuditResult(ctx, dedupeKey, { deliveryStatus });
        return notification.suppressed
          ? { ok: false, suppressed: true, error: "The manager has disabled these notifications." }
          : { ok: false, deliveryUnknown: true, error: "The manager notification outcome is not confirmed." };
      }
    } catch (error) {
      await updateAuditResult(ctx, dedupeKey, { deliveryStatus: "failed" }, { clearDedupeKey: true });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The manager notification could not be delivered.",
      };
    }
    await updateAuditResult(ctx, dedupeKey, { deliveryStatus: "delivered" });
    await ctx.db
      .from("agent_sessions")
      .update({ status: "escalated", updated_at: new Date().toISOString() })
      .eq("id", scope.sessionId)
      .eq("landlord_id", ctx.landlordId);
    track("leasing_sms_escalated", ctx.landlordId, { channel: emailedIn ? "email" : "sms" });
    return {
      ok: true,
      message: "The manager has been notified and will follow up.",
      // An audit record only prevents repeat notices. It is never proof that a
      // manager can see this handoff, so only the notifier's explicit delivery
      // result may authorize the SMS runtime to stay quiet.
      quietHandoff: input.handoff === "quiet" && notification.delivered && !notification.suppressed,
    };
  },
});
