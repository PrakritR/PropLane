/**
 * "Find me a room": the PropLane public catalog for a signed-in resident in the portal assistant.
 *
 * A resident who has not leased yet asks the in-app assistant the same thing a prospect texts the PropLane line, so it
 * reads the same catalog the public `/rent` pages show (every manager's live, public-projected listings) and answers
 * with absolute links: the listing, its tour page and its apply page. Read-only and identity-free: the context carries
 * no prospect phone, no session and no write authority, so nothing here tags a thread, notifies a manager or files a
 * lead (that is `build_prospect_links` on the leasing line, deliberately not reused). Portal channel only; resident SMS
 * keeps its own manager-scoped listing tools.
 */
import { z } from "zod";
import type { AgentContext, LeasingSmsAgentScope } from "../../context";
import type { ResidentAgentContext } from "../../resident-context";
import { defineTool } from "../../registry";
import { listLiveListingsTool, publicOrigin } from "../leasing-sms";

export const FIND_PUBLIC_HOMES_TOOL_NAME = "find_homes_on_proplane";

/** The public-catalog read context. Exported for tests: it must never carry a prospect identity or the service catalog. */
export function publicCatalogContext(ctx: ResidentAgentContext): AgentContext {
  const scope = {
    sessionId: `resident-portal:${ctx.userId}`,
    prospectPhoneE164: "",
    channel: "sms",
    workNumber: null,
    crossCatalog: true,
    serviceCatalog: false,
    lockedHome: null,
    currentInboundText: "",
  } satisfies LeasingSmsAgentScope;
  return {
    landlordId: "",
    userId: ctx.userId,
    email: ctx.email,
    roles: ["resident"],
    isAdmin: false,
    db: ctx.db,
    listingPublicOnly: true,
    leasingScope: scope,
  };
}

const inputSchema = z
  .object({
    query: z.string().max(200).optional().describe("A house name, street or room the resident named."),
    area: z.string().max(120).optional().describe("A place in their words: \"University of Washington\", \"U District\", \"98105\"."),
  })
  .strict();

export const findHomesOnPropLaneTool = defineTool<z.infer<typeof inputSchema>, Record<string, unknown>, ResidentAgentContext>({
  name: FIND_PUBLIC_HOMES_TOOL_NAME,
  description:
    "Search every live home and room listed on PropLane (the public /rent catalog) when the resident is looking for a place: rooms near a campus or neighborhood, under a price, or a house they saw. Pass a place as `area` exactly as they said it. Each home returns its rooms with CHECKED availability (never state a room is available unless currentAvailabilityVerified is true), lowestRoomRent, and three links from the tool: listingUrl, tourUrl (book a tour) and applyUrl. Reply with the matching homes and paste the links exactly as returned; offer browseUrl to see everything.",
  kind: "read",
  inputSchema,
  handler: async (ctx, input) => {
    const result = (await listLiveListingsTool.handler(publicCatalogContext(ctx), input)) as {
      listings: Array<Record<string, unknown> & { propertyId: string }>;
    } & Record<string, unknown>;
    const origin = publicOrigin();
    return {
      ...result,
      listings: result.listings.slice(0, 12).map((home) => ({
        ...home,
        tourUrl: `${origin}/rent/tours-contact?propertyId=${encodeURIComponent(home.propertyId)}`,
        applyUrl: `${origin}/rent/apply?propertyId=${encodeURIComponent(home.propertyId)}`,
      })),
    };
  },
});
