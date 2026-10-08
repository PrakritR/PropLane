/**
 * The resident personal agent's ENTIRE capability surface (docs/ai-assistant.md § Resident personal
 * agent): search the PUBLIC catalog, see a listing's open tour times, and - after the resident says
 * YES by text - request a tour or send an inquiry to that listing's manager.
 *
 * Invariants this file keeps:
 *  - The resident is the number owner (`ctx.userId`, `ctx.email`, `ctx.phoneE164`), resolved by the
 *    inbound handler from our own table. No tool input names a person, a manager or a phone.
 *  - A listing is addressed by its public `listingId` only. The managing user, the manager's email and
 *    the host of a tour slot are re-derived on the server from the published catalog and from
 *    `listOpenTourSlots` in BOTH the preview and the handler, so a model-chosen id proves nothing.
 *  - Reads return allowlisted public cards (`listing-search.ts`), never a listing record.
 *  - Both writes are `defineWriteTool`s that are NOT allow-listed for inline execution: the loop
 *    proposes, the SMS surface texts the exact preview, and only the resident's own YES runs the
 *    handler through the shared confirm gate.
 *  - They reach the manager through the same paths a signed-in resident's browser uses
 *    (`createTourInquiry`, `deliverResidentPropertyManagerChatMessage`), so the manager sees a normal
 *    tour request / resident message and approval-first still applies: nothing here books a tour.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MockProperty } from "@/data/types";
import { defineTool, defineWriteTool } from "../registry";
import type { ResidentPersonalAgentContext } from "../resident-personal-agent-context";
import { auditDayBucket, updateAuditResult, writeAuditLog } from "../audit";
import { searchResidentListings } from "@/lib/resident-agent/listing-search";
import { loadOfferedSlots } from "./tours";
import { applicationBeforeTourRefusal } from "@/lib/application-before-tour.server";
import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { formatTourRangeLabel } from "@/lib/tour-inquiry.server";
import { normalizeTourFormat } from "@/lib/tour-format";
import {
  deliverResidentPropertyManagerChatMessage,
  propertyManagerSendMessageIds,
} from "@/lib/property-manager-inbox-thread.server";

export const RESIDENT_AGENT_SEARCH_TOOL = "search_listings";
export const RESIDENT_AGENT_TOUR_TIMES_TOOL = "get_tour_times";
export const RESIDENT_AGENT_REQUEST_TOUR_TOOL = "request_tour";
export const RESIDENT_AGENT_SEND_INQUIRY_TOOL = "send_inquiry";

const TOUR_SLOTS_SHOWN = 12;

type PublicListing = MockProperty & { managerUserId: string };

function listingName(p: MockProperty): string {
  return (p.buildingName || p.title || p.address || "this listing").trim();
}

/** A live, public listing by its id, or a message the model can relay. Never a private record. */
async function requirePublicListing(ctx: ResidentPersonalAgentContext, listingId: string): Promise<PublicListing> {
  const listings = await ctx.loadListings();
  const found = listings.find((p) => p.id === listingId);
  if (!found) throw new Error("That listing is not available right now. Search again to see current listings.");
  if (!found.managerUserId) throw new Error("That listing cannot be contacted through the agent right now.");
  return found as PublicListing;
}

function contactName(ctx: ResidentPersonalAgentContext): string {
  return ctx.fullName || ctx.email.split("@")[0] || "PropLane resident";
}

/** The currently open slot for this listing, with the host the SERVER chose for it. */
async function requireOpenSlot(ctx: ResidentPersonalAgentContext, listing: PublicListing, slotKey: string) {
  const offered = await loadOfferedSlots(ctx.db as Parameters<typeof loadOfferedSlots>[0], {
    propertyId: listing.id,
    buildingName: listing.buildingName,
    address: listing.address,
  });
  const match = offered.slots.find((slot) => slot.slotKey === slotKey);
  if (!match) throw new Error("That tour time is no longer open. Ask for the current times with get_tour_times.");
  return match;
}

// ---------------------------------------------------------------------------------------------
// search_listings
// ---------------------------------------------------------------------------------------------

const searchInput = z
  .object({
    area: z.string().trim().max(80).optional().describe("Neighborhood, street, city or ZIP the resident named, e.g. Ballard."),
    beds: z.number().int().min(0).max(6).optional().describe("Bedrooms in the home. 0 is a studio; 3 means three or more."),
    maxRent: z.number().positive().max(100000).optional().describe("Highest monthly rent in whole dollars."),
    moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Move-in date as YYYY-MM-DD, only if the resident gave one."),
    term: z.enum(["short", "long"]).optional().describe("short for a short-term stay, long for a standard lease. Omit if not said."),
  })
  .strict();

export const searchListingsTool = defineTool<z.infer<typeof searchInput>, unknown, ResidentPersonalAgentContext>({
  name: RESIDENT_AGENT_SEARCH_TOOL,
  description:
    "Search PropLane's published listings across every property manager. Returns at most six cards with the listing id, name, address, neighborhood, bedrooms, lowest rent, availability and lease types. This is the ONLY source of listings, rents and availability: never state one that is not in a result. Omit a filter the resident did not give.",
  inputSchema: searchInput,
  handler: async (ctx, input) => {
    const listings = await ctx.loadListings();
    return searchResidentListings(listings, input);
  },
});

// ---------------------------------------------------------------------------------------------
// get_tour_times
// ---------------------------------------------------------------------------------------------

const tourTimesInput = z
  .object({
    listingId: z.string().trim().min(1).max(200).describe("The listingId from search_listings."),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Pacific start date, inclusive."),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Pacific end date, inclusive."),
  })
  .strict();

export const getTourTimesTool = defineTool<z.infer<typeof tourTimesInput>, unknown, ResidentPersonalAgentContext>({
  name: RESIDENT_AGENT_TOUR_TIMES_TOOL,
  description:
    "The tour times currently open for one listing (published availability minus busy minus booked, the same grid the public booking page shows). This is the ONLY source of bookable times: always call it before offering or requesting a time, and copy slotKey verbatim into request_tour.",
  inputSchema: tourTimesInput,
  handler: async (ctx, input) => {
    const listing = await requirePublicListing(ctx, input.listingId);
    const offered = await loadOfferedSlots(ctx.db as Parameters<typeof loadOfferedSlots>[0], {
      propertyId: listing.id,
      buildingName: listing.buildingName,
      address: listing.address,
      fromDate: input.fromDate,
      toDate: input.toDate,
    });
    return {
      listing: listingName(listing),
      timeZone: offered.timeZone,
      currentPacificDate: offered.currentPacificDate,
      currentPacificWeekday: offered.currentPacificWeekday,
      total: offered.total,
      slots: offered.slots.slice(0, TOUR_SLOTS_SHOWN).map((slot) => ({ slotKey: slot.slotKey, label: slot.label })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// request_tour (write, confirm-first)
// ---------------------------------------------------------------------------------------------

const requestTourInput = z
  .object({
    listingId: z.string().trim().min(1).max(200).describe("The listingId from search_listings."),
    slotKey: z.string().trim().min(1).max(40).describe("The chosen slotKey, copied verbatim from get_tour_times."),
    notes: z.string().trim().max(300).optional().describe("Anything the resident wants the manager to know."),
  })
  .strict();

export const requestTourTool = defineWriteTool<z.infer<typeof requestTourInput>, { reply: string }, ResidentPersonalAgentContext>({
  name: RESIDENT_AGENT_REQUEST_TOUR_TOOL,
  description:
    "Ask a listing's property manager for a tour at an open time. This files a tour REQUEST the manager approves, exactly like the website's booking form: it does not book anything. Needs a listingId from search_listings and a slotKey from get_tour_times. The resident confirms the exact request by text before it is sent.",
  inputSchema: requestTourInput,
  preview: async (ctx, input) => {
    const listing = await requirePublicListing(ctx, input.listingId);
    const refusal = await applicationBeforeTourRefusal(ctx.db as Parameters<typeof applicationBeforeTourRefusal>[0], {
      propertyId: listing.id,
      verifiedEmail: ctx.email,
    });
    if (refusal) throw new Error(refusal);
    const slot = await requireOpenSlot(ctx, listing, input.slotKey);
    return {
      kind: RESIDENT_AGENT_REQUEST_TOUR_TOOL,
      title: "Request a tour",
      summary: `Ask the manager of ${listingName(listing)} for a tour.`,
      fields: [
        { label: "Property", value: listingName(listing) },
        { label: "Time", value: formatTourRangeLabel(slot.start, slot.end) },
        { label: "Shared with the manager", value: `${contactName(ctx)}, ${ctx.phoneE164}` },
        ...(input.notes ? [{ label: "Notes", value: input.notes }] : []),
      ],
      warnings: ["This sends a request. The manager confirms the time before it is booked."],
      confirmLabel: "Send tour request",
    };
  },
  handler: async (ctx, input) => {
    const listing = await requirePublicListing(ctx, input.listingId);
    const refusal = await applicationBeforeTourRefusal(ctx.db as Parameters<typeof applicationBeforeTourRefusal>[0], {
      propertyId: listing.id,
      verifiedEmail: ctx.email,
    });
    if (refusal) throw new Error(refusal);
    // Re-derived NOW: the slot may have been taken since the preview, and the host is the server's pick.
    const slot = await requireOpenSlot(ctx, listing, input.slotKey);

    const dedupeKey = `resident_agent_request_tour:${ctx.userId}:${listing.id}:${slot.slotKey}`;
    const audit = await writeAuditLog(ctx, {
      action: "resident_agent.request_tour",
      toolName: RESIDENT_AGENT_REQUEST_TOUR_TOOL,
      inputSummary: { listingId: listing.id, slotKey: slot.slotKey },
      dedupeKey,
    });
    if (!audit.recorded && audit.duplicate) {
      return { reply: `You already asked for ${formatTourRangeLabel(slot.start, slot.end)} at ${listingName(listing)}. The manager will confirm.` };
    }

    const created = await createTourInquiry(ctx.db as Parameters<typeof createTourInquiry>[0], {
      incoming: {
        kind: "tour",
        propertyId: listing.id,
        propertyTitle: listingName(listing),
        managerUserId: slot.hostUserId,
        name: contactName(ctx),
        email: ctx.email,
        phone: ctx.phoneE164,
        notes: input.notes?.trim() || undefined,
        tourFormat: normalizeTourFormat(undefined),
        slotKey: slot.slotKey,
        proposedStart: slot.start,
        proposedEnd: slot.end,
        requestedWindows: [{ start: slot.start, end: slot.end, slotKey: slot.slotKey, adminUserId: slot.hostUserId }],
      },
      verifiedApplicantEmail: ctx.email,
    });
    if (!created.ok) {
      await updateAuditResult(ctx, dedupeKey, { ok: false }, { clearDedupeKey: true });
      throw new Error(created.error);
    }
    await updateAuditResult(ctx, dedupeKey, { ok: true });
    return {
      reply: `Requested ${formatTourRangeLabel(slot.start, slot.end)} with ${listingName(listing)}'s manager. I will not book anything: they confirm the time.`,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// send_inquiry (write, confirm-first)
// ---------------------------------------------------------------------------------------------

const sendInquiryInput = z
  .object({
    listingId: z.string().trim().min(1).max(200).describe("The listingId from search_listings."),
    message: z.string().trim().min(1).max(600).describe("The message to the property manager, written in the resident's voice."),
  })
  .strict();

async function managerEmailFor(ctx: ResidentPersonalAgentContext, listing: PublicListing): Promise<string> {
  const published = (listing.managerContactEmail || listing.contactWorkEmail || "").trim().toLowerCase();
  if (published.includes("@")) return published;
  const { data } = await ctx.db.from("profiles").select("email").eq("id", listing.managerUserId).maybeSingle();
  const email = String((data as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("That manager cannot be messaged through the agent right now.");
  return email;
}

export const sendInquiryTool = defineWriteTool<z.infer<typeof sendInquiryInput>, { reply: string }, ResidentPersonalAgentContext>({
  name: RESIDENT_AGENT_SEND_INQUIRY_TOOL,
  description:
    "Send a message from the resident to a listing's property manager. It opens or continues the resident's conversation with that manager in PropLane, where the manager replies. Use it for a question the listing data does not answer. The resident confirms the exact message by text before it is sent.",
  inputSchema: sendInquiryInput,
  preview: async (ctx, input) => {
    const listing = await requirePublicListing(ctx, input.listingId);
    return {
      kind: RESIDENT_AGENT_SEND_INQUIRY_TOOL,
      title: "Message the manager",
      summary: `Send this to the manager of ${listingName(listing)}.`,
      fields: [
        { label: "Property", value: listingName(listing) },
        { label: "Message", value: input.message },
        { label: "Shared with the manager", value: `${contactName(ctx)}, ${ctx.email}` },
      ],
      warnings: ["The manager replies in PropLane."],
      confirmLabel: "Send message",
    };
  },
  handler: async (ctx, input) => {
    // Authorize, then append: the listing must be live and public RIGHT NOW, and the manager is the
    // one the catalog row names - nothing about the recipient comes from the model.
    const listing = await requirePublicListing(ctx, input.listingId);
    const managerEmail = await managerEmailFor(ctx, listing);
    const day = auditDayBucket(ctx.now ?? new Date());
    const sendId = createHash("sha256").update(`resident-agent-inquiry|${listing.id}|${input.message}|${day}`).digest("hex").slice(0, 32);
    const subject = `Question about ${listingName(listing)}`;
    await deliverResidentPropertyManagerChatMessage(ctx.db as Parameters<typeof deliverResidentPropertyManagerChatMessage>[0], {
      residentEmail: ctx.email,
      residentUserId: ctx.userId,
      residentName: contactName(ctx),
      managerUserId: listing.managerUserId,
      managerEmail,
      propertyId: listing.id,
      propertyTitle: listingName(listing),
      subject,
      message: input.message,
      messageIds: propertyManagerSendMessageIds(ctx.userId, sendId, {
        managerUserId: listing.managerUserId,
        propertyId: listing.id,
        recipientEmail: managerEmail,
      }),
    });
    await writeAuditLog(ctx, {
      action: "resident_agent.send_inquiry",
      toolName: RESIDENT_AGENT_SEND_INQUIRY_TOOL,
      inputSummary: { listingId: listing.id },
      resultSummary: { ok: true },
      dedupeKey: `resident_agent_send_inquiry:${ctx.userId}:${sendId}`,
    });
    return { reply: `Sent to ${listingName(listing)}'s manager. They will reply in your PropLane inbox.` };
  },
});
