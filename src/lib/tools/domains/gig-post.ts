import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog, auditDayBucket } from "../audit";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { fanOutGigOffers } from "@/lib/jobs/gig-offers.server";
import { formatGigUsd, GIG_KIND_LABEL, GIG_MAX_CENTS, GIG_MIN_CENTS, parseGigRequest, type GigKind } from "@/lib/jobs/gig-parse";
import { createGigPost, findOwnedHomesByStreetNumber, gigServiceTitle, loadOwnedGigHome, type GigHome } from "@/lib/jobs/gig-posts.server";
import { propertyInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

/**
 * `post_gig` (PropLane Jobs): "need someone to show 4709A Room 3 Saturday 2pm, I'll pay $40" becomes a priced service on
 * the work board, offered by text to vendors who cover the area.
 *
 * The price is NEVER the model's: the tool takes the manager's own words (`request`) and the amount, the kind of job and
 * the time are read from them by code (`parseGigRequest`), then shown back on the confirmation card and confirmed with an
 * explicit YES. Two different figures, no figure, or an absurd one refuses and the agent asks the manager. The home is
 * re-derived from the manager's own records at preview AND at execute; the manager id is the authenticated context's.
 * Non-destructive: it posts an offer, it hires nobody and moves no money (the manager still approves one submitted bid).
 */

const inputSchema = z
  .object({
    request: z.string().min(3).max(600).describe("The manager's exact words, including the price they stated. The amount is read from this text by code; never compute or restate it."),
    propertyId: z.string().max(200).optional().describe("The home's id from list_properties, when known. Omit to match the street number in the request."),
    roomLabel: z.string().max(40).optional().describe("A room label such as 'Room 3', when the request names one."),
    kind: z.enum(["tour_showing", "cleaning", "other"]).optional().describe("Only to override the kind read from the request."),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;

type Resolved = { home: GigHome; kind: GigKind; offeredCents: number; whenText: string; whenStartIso: string | null; roomLabel: string | null };

async function resolve(ctx: AgentContext, input: Input): Promise<Resolved> {
  // A delegated co-manager (someone else's number) never posts: same rule as post_service_to_board.
  if (ctx.landlordId !== ctx.userId || ctx.managerSmsAccess?.mode === "delegated") {
    throw new Error("Posting a job is not available on another manager's account.");
  }
  if ((await resolveAuthenticatedBusinessAccess(ctx.userId, ctx.db)).kind !== "normal") {
    throw new Error("Posting jobs is unavailable for this account.");
  }
  const parsed = parseGigRequest(input.request, new Date());
  if (parsed.amount.kind === "none") throw new Error("The request has no price. Ask the landlord how much they will pay for this job (for example $40), then call again with their reply included in request.");
  if (parsed.amount.kind === "ambiguous") throw new Error("The request states more than one price. Ask the landlord which single amount they will pay.");
  if (parsed.amount.kind === "too_high") throw new Error(`A job price must be between ${formatGigUsd(GIG_MIN_CENTS)} and ${formatGigUsd(GIG_MAX_CENTS)}. Ask the landlord to confirm the amount.`);

  let home: GigHome | null = null;
  if (input.propertyId?.trim()) {
    home = await loadOwnedGigHome(ctx.db, ctx.landlordId, input.propertyId);
    if (!home) throw new Error("That home is not one of this landlord's. Use list_properties for valid ids.");
  } else if (parsed.home.streetNumber) {
    const matches = await findOwnedHomesByStreetNumber(ctx.db, ctx.landlordId, parsed.home.streetNumber);
    if (matches.length > 1) throw new Error(`More than one home matches ${parsed.home.streetNumber}: ${matches.map((m) => m.label).join("; ")}. Ask which one.`);
    home = matches[0] ?? null;
  }
  if (!home) throw new Error("Which home is this for? Ask the landlord, or use list_properties to find it.");
  if (!propertyInAgentWorkspace(ctx.workspace, home.id)) throw new Error("That home is in another workspace. Switch workspace to post a job for it.");
  const kind = input.kind ?? parsed.kind;
  return {
    home,
    kind,
    offeredCents: parsed.amount.amountCents,
    whenText: parsed.when.text,
    whenStartIso: parsed.when.startIso,
    roomLabel: input.roomLabel?.trim() || parsed.home.roomLabel,
  };
}

export const postGigTool = defineWriteTool({
  name: "post_gig",
  description:
    "Post a priced job for a vendor to take: a tour showing ('need someone to show Room 3 Saturday 2pm, I'll pay $40'), a cleaning ('clean my rooms at 5257 this week, $120') or another small job. Pass the landlord's own words in request: the price, the kind of job and the time are read from them by code. The home must be one of theirs. Nearby vendors are texted the job (area, time and price only, never the address) and the landlord approves whoever takes it. If the request has no price, ask for one first. The landlord confirms with YES.",
  inputSchema,
  preview: async (ctx, input) => {
    const r = await resolve(ctx, input);
    return {
      kind: "post_gig",
      title: "Post a job to vendors",
      summary: `Offer ${gigServiceTitle(r.kind, r.roomLabel)} at ${r.home.label} for ${formatGigUsd(r.offeredCents)}${r.whenText ? `, ${r.whenText}` : ""}.`,
      confirmLabel: "Post the job",
      fields: [
        { label: "Job", value: GIG_KIND_LABEL[r.kind] },
        { label: "Home", value: r.roomLabel ? `${r.home.label}, ${r.roomLabel}` : r.home.label },
        { label: "When", value: r.whenText || "Flexible" },
        { label: "You will pay", value: formatGigUsd(r.offeredCents) },
        { label: "Vendors see", value: "the kind of job, the area, the time and the price. Not the address." },
      ],
      confirmedInput: input,
    };
  },
  handler: async (ctx, input) => {
    const r = await resolve(ctx, input);
    const dedupeKey = `post_gig:${ctx.landlordId}:${r.home.id}:${r.roomLabel ?? ""}:${r.kind}:${r.offeredCents}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "post_gig",
      toolName: "post_gig",
      inputSummary: { propertyId: r.home.id, kind: r.kind, offeredCents: r.offeredCents },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That exact job was already posted today, so nothing new was posted." };
      throw new Error("Could not record the action; nothing was posted.");
    }
    const posted = await createGigPost(ctx.db, {
      managerUserId: ctx.landlordId,
      workspaceId: ctx.workspace?.id || null,
      propertyId: r.home.id,
      roomLabel: r.roomLabel,
      kind: r.kind,
      offeredCents: r.offeredCents,
      whenText: r.whenText || null,
      whenStartIso: r.whenStartIso,
      source: "sms",
      dedupeKey,
    });
    if (!posted.ok) throw new Error(posted.error);
    const fan = posted.created ? await fanOutGigOffers(ctx.db, posted.gigId).catch(() => null) : null;
    const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
    const link = `${origin}/portal/services/${posted.workOrderId}`;
    const reach = fan && fan.sent > 0 ? `I texted ${fan.sent} nearby vendor${fan.sent === 1 ? "" : "s"}.` : "It is on the vendor work board now.";
    return {
      reply: `Posted: ${gigServiceTitle(r.kind, r.roomLabel)} at ${r.home.label}${r.whenText ? `, ${r.whenText}` : ""}, ${formatGigUsd(r.offeredCents)}. ${reach} I will text you when someone takes it, and you approve who does it. ${link}`,
      resultSummary: { workOrderId: posted.workOrderId, gigId: posted.gigId, offered: fan?.sent ?? 0 },
    };
  },
});

export const managerGigTools = [postGigTool];
