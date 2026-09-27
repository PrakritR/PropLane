/** Public listing reads for a verified resident texting a manager's work line. */
import { z } from "zod";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import type { AgentContext } from "../../context";
import type { ResidentAgentContext } from "../../resident-context";
import { defineTool } from "../../registry";
import {
  listLiveListingsTool,
  publicOrigin,
  getListingDetailsTool,
  resolveLiveListingForSms,
} from "../leasing-sms";

function managerListingContext(ctx: ResidentAgentContext): AgentContext {
  const owner = ctx.activeManagerId?.trim();
  if (ctx.channel !== "sms" || !owner || !ctx.managerIds.includes(owner)) {
    throw new Error("Listing lookup is unavailable for this resident SMS session.");
  }
  return {
    landlordId: owner,
    userId: ctx.userId,
    email: ctx.email,
    roles: ["resident"],
    isAdmin: false,
    db: ctx.db,
    listingPublicOnly: true,
    // Deliberately omit leasingScope: this is one manager's public inventory,
    // never the shared cross-catalog or prospect write surface.
  };
}

export const residentSmsListLiveListingsTool = defineTool<
  z.infer<typeof listLiveListingsTool.inputSchema>,
  Awaited<ReturnType<typeof listLiveListingsTool.handler>>,
  ResidentAgentContext
>({
  name: "list_live_listings",
  description: "Find live listings and rooms belonging to the manager whose work number this resident texted. Use the result to resolve a house or room before asking for details.",
  inputSchema: listLiveListingsTool.inputSchema,
  handler: async (ctx, input) => listLiveListingsTool.handler(managerListingContext(ctx), input),
});

export const residentSmsGetListingDetailsTool = defineTool<
  z.infer<typeof getListingDetailsTool.inputSchema>,
  Awaited<ReturnType<typeof getListingDetailsTool.handler>>,
  ResidentAgentContext
>({
  name: "get_listing_details",
  description: "Read the manager's live listing and room facts, including furnishing and verified current room availability when the occupancy read succeeds. If verification fails, current availability is unknown; a saved published label is only attributed listing copy.",
  inputSchema: getListingDetailsTool.inputSchema,
  handler: async (ctx, input) => getListingDetailsTool.handler(managerListingContext(ctx), input),
});

export const residentSmsGetListingLinkTool = defineTool<
  { propertyId: string },
  { ok: boolean; listingUrl?: string; error?: string },
  ResidentAgentContext
>({
  name: "get_listing_link",
  description: "Get the public listing URL for a resolved live listing belonging to this manager. Send it with an answer about the home.",
  inputSchema: z.object({ propertyId: z.string().min(1) }).strict(),
  handler: async (ctx, input) => {
    const listing = await resolveLiveListingForSms(managerListingContext(ctx), input.propertyId);
    if (!listing) return { ok: false, error: "listing_not_found" };
    return { ok: true, listingUrl: buildManagerListingUrl(publicOrigin(), listing) };
  },
});

export const residentSmsListingTools = [
  residentSmsListLiveListingsTool,
  residentSmsGetListingDetailsTool,
  residentSmsGetListingLinkTool,
];
