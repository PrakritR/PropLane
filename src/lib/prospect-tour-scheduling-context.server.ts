import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProspectTourSchedulingContext = {
  propertyId: string;
  roomId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  constraints: { fromDate?: string; toDate?: string; localStartMinute?: number; localEndMinute?: number } | null;
  selectedOffer: { slotKey: string; start: string; end: string; hostUserId: string } | null;
  revision: number;
};

type ToolEvidence = { tool: string; input: unknown; output: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inboundContact(textValue: string | undefined): { contactName: string | null; contactEmail: string | null } {
  const body = textValue?.trim() ?? "";
  const email = body.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? null;
  const nameMatch = body.match(/\b(?:my name is|this is|i am|i'm)\s+([a-z][a-z .'-]{1,78})/i)?.[1] ?? null;
  const contactName = nameMatch?.replace(/\s+(?:and|email is|email)\b.*$/i, "").trim() || null;
  return { contactName, contactEmail: email?.toLowerCase() ?? null };
}

function extractUpdate(evidence: readonly ToolEvidence[], trustedInboundText?: string): {
  propertyId: string | null; roomId: string | null; contactName: string | null; contactEmail: string | null;
  constraints: ProspectTourSchedulingContext["constraints"];
} {
  let propertyId: string | null = null;
  let roomId: string | null = null;
  let contactName: string | null = null;
  let contactEmail: string | null = null;
  let constraints: ProspectTourSchedulingContext["constraints"] = null;
  for (const item of evidence) {
    const input = record(item.input);
    const output = record(item.output);
    if (item.tool === "get_listing_details" && output?.found === true) {
      const listing = record(output.listing);
      propertyId = text(listing?.propertyId) ?? text(input?.propertyId) ?? propertyId;
    }
    if (item.tool === "list_open_tour_slots" && output?.publishedOnly === true && output.resolution === "resolved") {
      propertyId = text(input?.propertyId) ?? propertyId;
      const next = {
        fromDate: text(input?.fromDate) ?? undefined,
        toDate: text(input?.toDate) ?? undefined,
        localStartMinute: number(input?.localStartMinute),
        localEndMinute: number(input?.localEndMinute),
      };
      if (Object.values(next).some((value) => value !== undefined)) constraints = next;
    }
    if (item.tool === "prepare_prospect_tour_confirmation" || item.tool === "confirm_prospect_sms_tour" || item.tool === "request_tour") {
      propertyId = text(input?.propertyId) ?? propertyId;
      roomId = text(input?.roomId) ?? roomId;
      contactName = text(input?.name) ?? contactName;
      contactEmail = text(input?.email) ?? contactEmail;
    }
  }
  const parsed = inboundContact(trustedInboundText);
  return {
    propertyId,
    roomId,
    contactName: contactName ?? parsed.contactName,
    contactEmail: contactEmail ?? parsed.contactEmail,
    constraints,
  };
}

export async function loadProspectTourSchedulingContext(
  db: SupabaseClient,
  args: { managerUserId: string; conversationKey: string },
): Promise<ProspectTourSchedulingContext | null> {
  try {
    const { data, error } = await db.from("prospect_tour_scheduling_state")
      .select("property_id,room_id,contact_name,contact_email,selected_offer,revision,status")
      .eq("manager_user_id", args.managerUserId).eq("conversation_key", args.conversationKey)
      .in("status", ["collecting", "offered"]).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    const selected = record((data as { selected_offer?: unknown }).selected_offer);
    // Exact-offer fields deliberately remain top-level: the confirmation RPC
    // verifies those paths. Context is additive under `constraints`.
    const offer = selected && text(selected.slotKey) && text(selected.start) && text(selected.end) && text(selected.hostUserId)
      ? selected : record(selected?.selectedOffer);
    const constraints = record(selected?.constraints);
    return {
      propertyId: String((data as { property_id?: unknown }).property_id ?? "").trim(),
      roomId: text((data as { room_id?: unknown }).room_id),
      contactName: text((data as { contact_name?: unknown }).contact_name),
      contactEmail: text((data as { contact_email?: unknown }).contact_email),
      constraints: constraints ? {
        fromDate: text(constraints.fromDate) ?? undefined, toDate: text(constraints.toDate) ?? undefined,
        localStartMinute: number(constraints.localStartMinute), localEndMinute: number(constraints.localEndMinute),
      } : null,
      selectedOffer: offer ? { slotKey: text(offer.slotKey) ?? "", start: text(offer.start) ?? "", end: text(offer.end) ?? "", hostUserId: text(offer.hostUserId) ?? "" } : null,
      revision: Number((data as { revision?: unknown }).revision ?? 0),
    };
  } catch {
    // Older test/dev schemas do not yet have this additive table. Durable
    // context is an enhancement, not a reason to suppress a valid SMS reply.
    return null;
  }
}

/** Persist only tool-grounded facts. A new canonical property cancels the old
 * conversation/property attempt so an old exact offer cannot survive a correction. */
export async function persistProspectTourSchedulingContext(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    conversationKey: string;
    trustedPhoneE164: string;
    evidence: readonly ToolEvidence[];
    trustedInboundText?: string;
    burst?: { id: string; revision: number; workerId: string };
  },
): Promise<ProspectTourSchedulingContext | null> {
  const update = extractUpdate(args.evidence, args.trustedInboundText);
  if (!update.propertyId && !update.roomId && !update.contactName && !update.contactEmail && !update.constraints) return null;
  try {
    if (!args.burst || typeof (db as { rpc?: unknown }).rpc !== "function") return null;
    // The database validates and locks the exact current burst lease, selects
    // a contact-only reply's sole active property, invalidates corrections,
    // and merges without ever downgrading a terminal state.
    const { data, error } = await db.rpc("merge_prospect_sms_tour_context", {
      p_manager_user_id: args.managerUserId,
      p_conversation_key: args.conversationKey,
      p_trusted_phone_e164: args.trustedPhoneE164,
      p_property_id: update.propertyId,
      p_room_id: update.roomId,
      p_contact_name: update.contactName,
      p_contact_email: update.contactEmail,
      p_constraints: update.constraints,
      p_burst_id: args.burst.id,
      p_burst_revision: args.burst.revision,
      p_worker_id: args.burst.workerId,
    });
    if (error || (data as { ok?: unknown } | null)?.ok !== true) return null;
    return loadProspectTourSchedulingContext(db, args);
  } catch {
    return null;
  }
}

export function schedulingContextPrompt(context: ProspectTourSchedulingContext | null): string {
  if (!context) return "";
  const parts = [`Canonical property id: ${context.propertyId}.`];
  if (context.roomId) parts.push(`Canonical room id: ${context.roomId}.`);
  if (context.contactName) parts.push(`Known prospect name: ${context.contactName}.`);
  if (context.contactEmail) parts.push(`Known email: ${context.contactEmail}.`);
  if (context.constraints) parts.push(`Saved date/time constraints: ${JSON.stringify(context.constraints)}.`);
  if (context.selectedOffer) parts.push(`A previously selected offer is stale until fresh availability and explicit agreement are verified: ${JSON.stringify(context.selectedOffer)}.`);
  return parts.join(" ");
}
