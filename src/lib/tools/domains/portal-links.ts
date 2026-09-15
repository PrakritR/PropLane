/**
 * Link-first communication: the canonical PropLane pages every conversational
 * agent hands out instead of walking someone through a flow by chat.
 *
 * A texting prospect who wants to tour gets the tour page; a resident who wants
 * to pay gets the Payments page; a vendor asking about an invoice gets the
 * Invoices page. The agent still answers the question, but the page does the
 * work, so the reply stays short and the person lands on the real screen.
 *
 * These are pure URL builders: no database, no scope. The only authorization
 * in this file is `get_property_links`, which re-derives that the manager may
 * share the listing against the live record, exactly like `share_property_link`.
 *
 * Channel rule: an off-platform delivery (SMS, email, an unknown channel) always
 * gets absolute production URLs, because a relative path in a text message is
 * a dead link. Only a portal chat, where the person is already signed in on the
 * app, gets relative paths so the link opens inside the portal they are on.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import type { AgentContext } from "../context";
import type { ResidentAgentContext } from "../resident-context";
import type { VendorAgentContext } from "../vendor-context";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { residentPortalPath } from "@/lib/claw-resident-links";
import {
  buildManagerApplyUrl,
  buildManagerListingUrl,
  buildManagerTourUrl,
  buildPropertyMessageHref,
} from "@/lib/manager-property-links";

export type AgentLinkChannel = "portal" | "sms" | "email";

/** Origin for links that leave the platform. Phone- and inbox-reachable only, never localhost. */
export function agentLinkOrigin(): string {
  return PRODUCTION_APP_ORIGIN;
}

function absolutize<T extends Record<string, string>>(paths: T, channel: AgentLinkChannel | undefined): T {
  if (channel === "portal") return paths;
  const origin = agentLinkOrigin();
  return Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, `${origin}${p}`])) as T;
}

/** Resident portal pages, keyed by the request they answer. Exported for tests. */
export function residentLinkPaths() {
  return {
    /** Charges waiting on the resident: the page to pay from. */
    payments: residentPortalPath("payments"),
    /** Every charge, paid and pending. */
    charges: "/resident/payments",
    lease: residentPortalPath("lease"),
    application: residentPortalPath("applications"),
    /** House details, move-in checklist, housemates. */
    myHome: residentPortalPath("move_in"),
    /** Maintenance requests and add-on services. */
    services: residentPortalPath("services"),
    documents: "/resident/documents",
    inspections: "/resident/inspections",
    inbox: residentPortalPath("inbox"),
    /** Pick a real open time on the manager's calendar. */
    scheduleTour: "/resident/tour/schedule",
    settings: "/resident/profile",
    signIn: residentPortalPath("login"),
  } as const;
}

/** Vendor portal pages, keyed by the request they answer. Exported for tests. */
export function vendorLinkPaths() {
  return {
    dashboard: "/vendor/dashboard",
    /** Assigned and offered jobs (the product calls them services). */
    jobs: "/vendor/work-orders",
    tasks: "/vendor/tasks",
    calendar: "/vendor/calendar",
    inbox: "/vendor/communication/active",
    income: "/vendor/financials/income",
    invoices: "/vendor/financials/invoices",
    payments: "/vendor/payments",
    documents: "/vendor/documents/mine",
    /** Bank payout setup, W-9, insurance, licensing. */
    profile: "/vendor/profile",
    signIn: "/auth/sign-in",
  } as const;
}

const NO_INPUT = z.object({}).strict();
type NoInput = z.infer<typeof NO_INPUT>;
type LinksResult<T> = { links: T; channel: AgentLinkChannel };

export function residentLinks(channel: AgentLinkChannel | undefined) {
  return absolutize(residentLinkPaths(), channel);
}

export function vendorLinks(channel: AgentLinkChannel | undefined) {
  return absolutize(vendorLinkPaths(), channel);
}

const RESIDENT_LINKS_DESCRIPTION =
  "Canonical resident portal links: pay or view charges, sign or read the lease, the application, house details (My home), maintenance and services, documents, inspections, inbox, schedule a tour, settings, and sign in. Call this whenever the resident wants to DO something (pay, sign, file, upload, book, read a document) and send the matching link with a one-line answer, instead of walking them through it by chat. Links are ready to paste; never type a URL from memory.";

export const getResidentLinksTool = defineTool<NoInput, LinksResult<ReturnType<typeof residentLinks>>, ResidentAgentContext>({
  name: "get_resident_links",
  description: RESIDENT_LINKS_DESCRIPTION,
  kind: "read",
  inputSchema: NO_INPUT,
  handler: async (ctx) => {
    // No channel recorded means the reply may leave the platform: absolute.
    const channel: AgentLinkChannel = ctx.channel ?? "sms";
    return { links: residentLinks(channel), channel };
  },
});

const VENDOR_LINKS_DESCRIPTION =
  "Canonical vendor portal links: jobs (services), tasks, calendar, inbox, income, invoices, payments, documents, profile (bank payouts, W-9, insurance), and sign in. Call this whenever the vendor wants to DO something (see a job, submit an invoice, check a payout, update availability, upload a document) and send the matching link with a one-line answer, instead of walking them through it by chat. Never type a URL from memory.";

/** Vendor portal assistant: signed in on the app, so links stay in-app. */
export const getVendorLinksTool = defineTool<NoInput, LinksResult<ReturnType<typeof vendorLinks>>, VendorAgentContext>({
  name: "get_vendor_links",
  description: VENDOR_LINKS_DESCRIPTION,
  kind: "read",
  inputSchema: NO_INPUT,
  handler: async () => ({ links: vendorLinks("portal"), channel: "portal" }),
});

/**
 * The 24/7 one-job vendor SMS agent. A texting vendor is off-platform, so every
 * link is absolute. Pure URLs only: this registry must never grow a data read.
 */
export const getVendorSmsLinksTool = defineTool<NoInput, LinksResult<ReturnType<typeof vendorLinks>>, AgentContext>({
  name: "get_vendor_links",
  description: VENDOR_LINKS_DESCRIPTION,
  kind: "read",
  inputSchema: NO_INPUT,
  // The one-job agent only ever reaches a vendor off-platform (SMS or inbox
  // relay), so the link must be absolute either way.
  handler: async () => ({ links: vendorLinks("sms"), channel: "sms" }),
});

export type PropertyLinks = {
  ok: true;
  propertyId: string;
  title: string;
  /** Full listing page: photos, video, rooms, rent, policies. */
  listingUrl: string;
  /** Prospect picks a real open time; the manager confirms. */
  tourUrl: string;
  /** Rental application, prefilled with any room, bundle, and phone given. */
  applyUrl: string;
  /** Prospect leaves a message about this home. */
  messageUrl: string;
  prefilled: { listingRoomId: string | null; roomName: string | null; bundleId: string | null; phone: string | null };
};

/**
 * Build the shareable links for one live listing the manager owns or
 * co-manages. Same origin and authority check as `share_property_link`, minus
 * the email: the manager pastes these into a text reply, an inbox reply, or a
 * message, so a prospect asking to tour, apply, or see the home gets the page.
 */
export async function buildPropertyLinksForManager(
  ctx: AgentContext,
  input: { propertyId: string; listingRoomId?: string; roomName?: string; bundleId?: string; prospectPhone?: string },
): Promise<PropertyLinks | { ok: false; error: string }> {
  const { getShareablePropertyForUser } = await import("@/lib/manager-property-share-access");
  const property = await getShareablePropertyForUser(ctx.landlordId, input.propertyId);
  if (!property) {
    return {
      ok: false,
      error: "Only live listings you own or co-manage can be linked. Use list_properties with status 'live' to find one.",
    };
  }
  const origin = agentLinkOrigin();
  const propertyId = input.propertyId.trim();
  const listingRoomId = input.listingRoomId?.trim() || null;
  const roomName = input.roomName?.trim() || null;
  const bundleId = input.bundleId?.trim() || null;
  const phone = input.prospectPhone?.trim() || null;
  return {
    ok: true,
    propertyId,
    title: (property.title || property.buildingName || property.address || propertyId).trim(),
    listingUrl: buildManagerListingUrl(origin, propertyId),
    tourUrl: buildManagerTourUrl(origin, propertyId),
    applyUrl: buildManagerApplyUrl(origin, {
      propertyId,
      listingRoomId: listingRoomId ?? undefined,
      roomName: roomName ?? undefined,
      bundleId: bundleId ?? undefined,
      phone: phone ?? undefined,
    }),
    messageUrl: `${origin}${buildPropertyMessageHref(propertyId)}`,
    prefilled: { listingRoomId, roomName, bundleId, phone },
  };
}

export const getPropertyLinksTool = defineTool({
  name: "get_property_links",
  description:
    "Listing, tour, apply, and message links for one of the landlord's LIVE listings, ready to paste into a text reply, inbox reply, or message. Use whenever a prospect or applicant asks about a home, wants to tour, wants to apply, or asks for photos or a video: send the matching link instead of relaying details by chat. Apply links can prefill a room, bundle, and the prospect's phone. Pass a property id from list_properties (status 'live'). Links use the production domain, never localhost. To EMAIL an invite instead, use share_property_link.",
  kind: "read",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("The live property id, from list_properties."),
      listingRoomId: z.string().optional().describe("Optional room id to prefill on the application."),
      roomName: z.string().optional().describe("Optional room name to prefill on the application."),
      bundleId: z.string().optional().describe("Optional room-bundle id to prefill on the application."),
      prospectPhone: z
        .string()
        .optional()
        .describe("Optional prospect phone to prefill on the application, e.g. when replying to a text thread."),
    })
    .strict(),
  handler: buildPropertyLinksForManager,
});
