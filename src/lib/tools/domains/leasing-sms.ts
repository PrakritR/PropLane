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
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
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
      }));
  } catch {
    return [];
  }
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
  return {
    propertyId: rec.id,
    status: rec.status,
    title: propertyLabel(src),
    address: str(src, "address"),
    neighborhood: str(src, "neighborhood"),
    rentLabel: str(src, "rentLabel"),
    available: str(src, "available"),
    beds: typeof src?.beds === "number" ? src.beds : null,
    baths: typeof src?.baths === "number" ? src.baths : null,
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

/** True when a listing summary matches a free-text needle (address/name/room). */
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
    ...summary.rooms.map((r) => r.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (hay.includes(n)) return true;
  // Require every significant token (len > 2) so "8th Ave" does not also
  // match every other "… Ave …" listing.
  const words = n.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return false;
  return words.every((w) => hay.includes(w));
}

export const listLiveListingsTool = defineTool({
  name: "list_live_listings",
  description:
    "Search PropLane's live public listings — on the shared PropLane line this spans EVERY manager's listings (the same catalog as the public /rent site), so use it to find ANY house or room a prospect names. Returns title, address, neighborhood, rent label, and room names/prices. Use first when matching a prospect's house or room question.",
  kind: "read",
  inputSchema: z
    .object({
      query: z
        .string()
        .optional()
        .describe("Optional free-text filter (address fragment, house name, room name)."),
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
    "Full details for one live listing: address, rent, rooms (ids/names/prices/availability), bundles, and amenities. On the shared PropLane line this resolves ANY live listing on the platform. Call before answering specifics about a house or room.",
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
        description: str(src, "description")?.slice(0, 800) ?? null,
        rooms: matchedRooms,
        allRoomCount: rooms.length,
        bundles: summarizeBundles(src),
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

    await notifyManagerFromAgent(ctx.db, {
      landlordId: ctx.landlordId,
      subject: "Leasing text needs you",
      text: [
        `A prospect texted your work number (${scope.prospectPhoneE164}):`,
        "",
        input.summary,
        "",
        "Open Communication → SMS to reply from your work number.",
      ].join("\n"),
      threadType: "leasing_sms_escalation",
      url: "/portal/communication/sms",
      notify: { push: true, sms: true },
    });
    await ctx.db
      .from("agent_sessions")
      .update({ status: "escalated", updated_at: new Date().toISOString() })
      .eq("id", scope.sessionId);
    track("leasing_sms_escalated", ctx.landlordId, { channel: "sms" });
    return { ok: true, message: "The manager has been notified and will follow up." };
  },
});
