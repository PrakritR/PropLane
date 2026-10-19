import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import type { LeadOffer, LeadProfile } from "@/lib/one-number/lead-qualifying";
import { workspaceOwnedBy } from "@/lib/one-number/shared-line-number.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/** A hand-off stays "fresh" for the leasing agent this long. */
const HANDOFF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type LeadHandoff = {
  propertyId: string;
  roomId: string | null;
  label: string;
  rent: number | null;
  availability: string | null;
  budgetMax: number | null;
  moveInDate: string | null;
  leaseMonths: number | null;
};

/** The room a lead picked, from the stored offers (the pick stores the house; the offers carry the room). */
export function handoffFromLead(row: { assigned_property_id?: unknown; profile?: unknown }): LeadHandoff | null {
  const propertyId = String(row.assigned_property_id ?? "").trim();
  if (!propertyId) return null;
  const profile = (row.profile && typeof row.profile === "object" ? row.profile : {}) as LeadProfile;
  const offer: LeadOffer | undefined = (profile.offers ?? []).find((o) => o.propertyId === propertyId);
  return {
    propertyId,
    roomId: offer?.roomId ?? null,
    label: offer?.label ?? "",
    rent: offer?.rent ?? null,
    availability: offer?.availability ?? null,
    budgetMax: profile.budgetMax ?? null,
    moveInDate: profile.moveInDate ?? null,
    leaseMonths: profile.leaseMonths ?? null,
  };
}

/** The system-prompt paragraph that carries a hand-off to the leasing agent. Facts the prospect gave and the room they chose only. */
export function handoffPrompt(handoff: LeadHandoff): string {
  const facts: Record<string, unknown> = {
    propertyId: handoff.propertyId,
    ...(handoff.roomId ? { roomId: handoff.roomId } : {}),
    ...(handoff.label ? { address: handoff.label } : {}),
    ...(handoff.rent !== null ? { monthlyRent: handoff.rent } : {}),
    ...(handoff.availability ? { availability: handoff.availability } : {}),
    ...(handoff.budgetMax !== null ? { theirMonthlyBudget: handoff.budgetMax } : {}),
    ...(handoff.moveInDate ? { theirMoveInDate: handoff.moveInDate } : {}),
    ...(handoff.leaseMonths !== null ? { theirLeaseMonths: handoff.leaseMonths } : {}),
  };
  return (
    "This prospect started on the shared PropLane number and chose this home from the options already texted to them. " +
    "Treat it as the matched listing for this conversation: use these ids with your tools and do not ask which place they mean " +
    "unless they name a different one. Their answers are below; do not ask them again.\n" +
    JSON.stringify(facts)
  );
}

/**
 * The home a prospect picked on the shared line, for the leasing agent's first turns with the team that now owns
 * them. Null when there is none, the workspace is not the owner's, or the table is missing.
 */
export async function loadLeadHandoffPrompt(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null | undefined; phone: string | null | undefined },
): Promise<string | null> {
  const phoneKey = normalizeConsentPhone(String(input.phone ?? ""));
  if (!/^\d{10}$/.test(phoneKey)) return null;
  const workspaceId = await workspaceOwnedBy(db, input.ownerUserId, input.workspaceId);
  if (!workspaceId) return null;
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select("assigned_property_id, profile, assigned_at")
    .eq("phone_key", phoneKey)
    .eq("status", "assigned")
    .eq("assigned_workspace_id", workspaceId)
    .order("assigned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (!isMissingSchemaError(error)) console.error("lead hand-off read failed", error.code ?? "unknown");
    return null;
  }
  if (!data) return null;
  const assignedAt = Date.parse(String((data as { assigned_at?: unknown }).assigned_at ?? ""));
  if (!Number.isFinite(assignedAt) || Date.now() - assignedAt > HANDOFF_WINDOW_MS) return null;
  const handoff = handoffFromLead(data as { assigned_property_id?: unknown; profile?: unknown });
  return handoff ? handoffPrompt(handoff) : null;
}
