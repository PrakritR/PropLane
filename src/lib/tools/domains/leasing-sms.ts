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
} from "@/lib/manager-property-links";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { getPublicListings } from "@/lib/public-listings.server";
import {
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
} from "@/lib/manager-listing-submission";
import { listingOffersCustomLeaseSurcharge } from "@/lib/listing-fees";
import { roomDailyRentPrice, roomHeadlinePriceLabel, roomIsDailyPriced } from "@/lib/room-pricing";

export const LEASING_ESCALATE_TOOL_NAME = "escalate_to_manager";

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
 * Origin for links embedded in SMS. Phone-reachable only — never localhost.
 * Always uses the canonical PropLane production domain. Legacy Axis-host
 * environment values may remain for old infrastructure, but must never leak
 * into a prospect-facing agent reply.
 */
export function publicOrigin(): string {
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
      availability: string | null;
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
        priceLabel: roomHeadlinePriceLabel(r, "") || null,
        availability: r.availability?.trim() || null,
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
        shortLeaseSurchargeMonthly: room.shortLeaseSurchargeMonthly,
        shortLeaseMaxMonths: room.shortLeaseMaxMonths,
      })),
      termSurcharges: [
        {
          term: "Month-to-Month",
          offered: availableTerms.includes("Month-to-Month"),
          monthlySurcharge: submission?.monthToMonthSurcharge?.trim() || null,
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
let catalogCache: { at: number; rows: RawPropertyRecord[] } | null = null;
let catalogInflight: Promise<RawPropertyRecord[]> | null = null;

async function loadPublicCatalogRows(): Promise<RawPropertyRecord[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows;
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    try {
      const listings = await getPublicListings();
      const rows = listings.map(mockPropertyToRecord);
      catalogCache = { at: Date.now(), rows };
      return rows;
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
}

/** Test-only: drop the catalog memo so fixtures aren't shadowed across tests. */
export function __resetLeasingCatalogCache(): void {
  catalogCache = null;
  catalogInflight = null;
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
  return loadOwnedLiveListings(ctx);
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
  if (owned) return owned;
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
    available: str(src, "available"),
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
      availability: r.availability,
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
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !LISTING_MATCH_STOPWORDS.has(w));
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
    "Search PropLane's live public listings — on the shared PropLane line this spans EVERY manager's listings (the same catalog as the public /rent site), so use it to find ANY house or room a prospect names. Returns title, address, neighborhood, rent label, room names/prices, pet policy, and every marketing surface the manager wrote — the tagline, ad titles (alsoListedAs), and free-text notes about the home (marketingNotes) — all of which are searched, so pass the words a prospect quotes from an ad as the query. Use first when matching a prospect's house or room question.",
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
    const listings = rows
      .map(summarizeListingRecord)
      .filter((s) => listingSummaryMatches(s, needle))
      // Cap the payload the model sees (large catalogs); a needle narrows first.
      .slice(0, 40);
    return { count: listings.length, listings };
  },
});

export const getListingDetailsTool = defineTool({
  name: "get_listing_details",
  description:
    "Full prospect-safe details for one live listing: address, rooms and their published prices/availability, available lease terms with represented surcharges, nullable pet policy, listing and room security deposits, and utility estimates/payment model. On the shared PropLane line this resolves ANY live listing on the platform. Call before answering specifics about a house or room.",
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
    const facts = leasingListingFacts(src, rooms);
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
        available: str(src, "available"),
        beds: typeof src?.beds === "number" ? src.beds : null,
        baths: typeof src?.baths === "number" ? src.baths : null,
        tagline: str(src, "tagline"),
        marketingNotes: listingMarketingNotes(src),
        alsoListedAs: str(src, "alsoListedAs"),
        petFriendly: facts.petFriendly,
        description: str(src, "description")?.slice(0, 800) ?? null,
        rooms: matchedRooms,
        allRoomCount: rooms.length,
        bundles: summarizeBundles(src),
        leaseTerms: facts.leaseTerms,
        securityDeposit: facts.securityDeposit,
        utilities: facts.utilities,
      },
    };
  },
});

export const buildProspectLinksTool = defineTool({
  name: "build_prospect_links",
  description:
    "Build listing, tour, and apply URLs for a matched property (any live PropLane listing on the shared line). Apply links prefill the prospect's phone and optional room/bundle so the application form is already filled. Links always use the production domain, never localhost. Always use this before telling someone to apply or tour.",
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
      listingUrl: buildManagerListingUrl(origin, rec.id),
      tourUrl: buildManagerTourUrl(origin, rec.id),
      applyUrl,
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
 * agent never has to invent a URL (and never emits a localhost link). Use for
 * "how do I apply / where do I see all listings / how do I sign my lease" when
 * no specific property is matched yet.
 */
export function proplaneSiteLinks(origin: string) {
  const base = origin.replace(/\/$/, "");
  return {
    origin: base,
    browseHomes: `${base}/rent`,
    startApplication: `${base}/rent/apply`,
    pricing: `${base}/pricing`,
    demo: `${base}/demo`,
    docs: `${base}/docs`,
    residentPortal: residentPortalUrl("login"),
    residentSignup: residentPortalUrl("signup"),
    signLease: residentPortalUrl("lease"),
    payRent: residentPortalUrl("payments"),
  };
}

export const getSiteLinksTool = defineTool({
  name: "get_site_links",
  description:
    "Canonical PropLane site links (production domain, never localhost): browse all homes, start an application, book a tour, pricing, the live demo, and the resident portal for signing a lease or paying rent. Use when a prospect asks a general 'where do I …' question and no single property is matched. For a specific matched listing use build_prospect_links instead.",
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
    if (!scope) return { ok: false, error: "No leasing conversation bound." };

    const hourBucket = new Date().toISOString().slice(0, 13);
    const dedupeKey = `leasing_sms_escalate:${scope.sessionId}:${hourBucket}`;
    const { error: auditError } = await ctx.db.from("audit_log").insert({
      actor_user_id: ctx.landlordId,
      landlord_id: ctx.landlordId,
      action: "leasing_sms_escalate",
      tool_name: LEASING_ESCALATE_TOOL_NAME,
      input_summary: {
        prospectPhone: scope.prospectPhoneE164,
        prospectEmail: scope.prospectEmail ?? null,
        summary: input.summary.slice(0, 200),
      },
      dedupe_key: dedupeKey,
      created_at: new Date().toISOString(),
    });
    if (auditError) {
      if (auditError.code === "23505") {
        return {
          ok: true,
          alreadyEscalated: true,
          message: "The manager was already notified about this a moment ago.",
        };
      }
      return { ok: false, error: "Could not record the escalation." };
    }

    /* Name the channel the prospect actually used. Telling a manager someone
       "texted your work number ()" — with an empty phone — is worse than no
       notice at all: it points them at the wrong place to reply. */
    const emailedIn = scope.channel === "email";
    const contact = emailedIn
      ? scope.prospectEmail?.trim() || "an unknown address"
      : scope.prospectPhoneE164;
    await notifyManagerFromAgent(ctx.db, {
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
    });
    await ctx.db
      .from("agent_sessions")
      .update({ status: "escalated", updated_at: new Date().toISOString() })
      .eq("id", scope.sessionId);
    track("leasing_sms_escalated", ctx.landlordId, { channel: emailedIn ? "email" : "sms" });
    return { ok: true, message: "The manager has been notified and will follow up." };
  },
});
