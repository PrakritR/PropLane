/**
 * `send_listing_photos`: a prospect texts "can I see photos of the Brooklyn house" and gets the real
 * pictures as MMS from the PropLane line (the spec's "1-2 listing photos per match").
 *
 * Why it is a read tool that sends: like `send_my_link`, the destination is the phone that is TEXTING
 * (read from the verified session, never from the model), the content is the public listing photos
 * every browse page already shows, and the prospect asked for it. It goes through the one shared-line
 * door (`sendSharedLineMessage`: consent, quiet hours, opt-out, the stamped workspace's wallet), so it
 * is billed and logged like any other text. Only real https photos are ever sent; with none on file the
 * tool says so and the agent falls back to the listing link. Shared line only: on a per-workspace work
 * number the tool is not in the registry.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import type { AgentContext } from "../context";
import { getListingRichContent } from "@/data/listing-rich-content";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { toGsm7 } from "@/lib/one-number/segments";
import { collectPropertyMediaSlides } from "@/lib/room-listings-catalog";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { resolveLiveListingForSms } from "./leasing-sms";

export const MAX_LISTING_PHOTOS = 2;

export type SendListingPhotosResult =
  | { ok: true; sent: number; listing: string }
  | { ok: false; error: "photos_unavailable" | "not_found" | "no_photos" | "send_failed" };

/** Up to `limit` distinct real https photos of one listing, first photo of each room first. */
export function listingPhotoUrls(listing: Parameters<typeof getListingRichContent>[0], limit: number = MAX_LISTING_PHOTOS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slide of collectPropertyMediaSlides(getListingRichContent(listing))) {
    if (slide.kind !== "photo" || !/^https:\/\/[^\s]+$/i.test(slide.src) || seen.has(slide.src)) continue;
    seen.add(slide.src);
    out.push(slide.src);
    if (out.length >= limit) break;
  }
  return out;
}

export const leasingSendListingPhotosTool = defineTool<{ propertyId: string }, SendListingPhotosResult, AgentContext>({
  name: "send_listing_photos",
  description:
    "Text the prospect up to two real photos of ONE live listing as picture messages from the PropLane line. Use when they ask to see photos or pictures of a house or room, after you have the listing id from list_live_listings. If ok, say in one short line that the photos are on their way; do not describe photos you cannot see. If no_photos, say there are no photos on file yet and share the listing link instead. Only available while texting.",
  kind: "read",
  inputSchema: z.object({ propertyId: z.string().min(1).max(200) }).strict(),
  handler: async (ctx, input) => {
    const scope = ctx.leasingScope;
    if (!scope || scope.channel !== "sms" || !scope.prospectPhoneE164) return { ok: false, error: "photos_unavailable" };
    const listingId = await resolveLiveListingForSms(ctx, input.propertyId);
    if (!listingId) return { ok: false, error: "not_found" };

    const workspaceId = await resolveWorkspaceForProperty(ctx.db, listingId, ctx.landlordId);
    const config = await loadSharedLineConfig(ctx.db);
    if (!workspaceId || !workspaceOnSharedLine(config, workspaceId)) return { ok: false, error: "photos_unavailable" };

    // The public projection only: the same allowlisted listing every anonymous reader gets.
    const listing = (await getCrawlPublicListings()).find((p) => p.id === listingId);
    if (!listing) return { ok: false, error: "not_found" };
    const photos = listingPhotoUrls(listing);
    if (photos.length === 0) return { ok: false, error: "no_photos" };

    const label = toGsm7(listing.buildingName || listing.title || listing.address || "this house").slice(0, 80);
    // A repeat request later gets a fresh send; a retry of the same turn inside the hour does not double-send.
    const bucket = Math.floor(Date.now() / 3_600_000);
    const sent = await sendSharedLineMessage(ctx.db, {
      workspaceId,
      ownerUserId: ctx.landlordId,
      toPhone: scope.prospectPhoneE164,
      body: `Photos of ${label}`,
      role: "prospect",
      mediaUrls: photos,
      idempotencyKey: `listing-photos:${scope.sessionId}:${listingId}:${bucket}`,
    });
    return sent.ok ? { ok: true, sent: photos.length, listing: label } : { ok: false, error: "send_failed" };
  },
});
