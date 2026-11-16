import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { submissionToDraftAdminRow } from "@/lib/demo-admin-property-inventory";
import type { HouseHints } from "@/lib/one-number/onboarding/role-detect";
import { normalizeListingPhotoUrl } from "@/lib/listing-media-placement.server";
import { submissionFromImportedProperty } from "@/lib/property-import/to-submission";
import type { PropertyImportProperty } from "@/lib/property-import/types";

/**
 * The first property, pre-created as a DRAFT from what the landlord told the agent (address, rooms,
 * rent if given). It is `status: "draft"` on the ordinary record (docs/agents/property-drafts.md):
 * never public, never counted against the plan, finished in the Add property wizard. The id is
 * deterministic per (user, setup link), so a retried finish upserts the same row. Called only after
 * the phone is proven and the manager account exists; a demo alone never reaches this.
 */
export function hasHouseHints(hints: HouseHints): boolean {
  return Boolean(hints.address || hints.rooms || hints.rent);
}

export function draftIdFor(userId: string, linkId: string): string {
  return `mgr-text-${createHash("sha256").update(`${userId}:${linkId}`).digest("hex").slice(0, 12)}`;
}

export function importedPropertyFromHints(hints: HouseHints): PropertyImportProperty {
  const roomCount = Math.max(1, Math.min(20, hints.rooms ?? 1));
  const rentByRoom = roomCount > 1;
  const address = hints.address?.trim() ?? "";
  return {
    key: "text-setup",
    name: address || "My first house",
    address,
    city: "",
    state: "",
    zip: "",
    propertyType: "house",
    rentByRoom,
    bedrooms: roomCount,
    bathrooms: null,
    monthlyRent: !rentByRoom ? (hints.rent ?? null) : null,
    deposit: null,
    rooms: rentByRoom ? Array.from({ length: roomCount }, (_, i) => ({ label: `Room ${i + 1}`, rent: hints.rent ?? null, deposit: null, sourceRow: null })) : [],
    sourceSheet: "",
    sourceRows: [],
    needsLook: [],
    confidence: "medium",
  };
}

export async function createDraftFromHints(
  db: SupabaseClient,
  input: { userId: string; linkId: string; hints: HouseHints },
): Promise<{ created: boolean; propertyId: string | null }> {
  if (!hasHouseHints(input.hints)) return { created: false, propertyId: null };
  const propertyId = draftIdFor(input.userId, input.linkId);
  const submission = submissionFromImportedProperty(importedPropertyFromHints(input.hints));
  const row = {
    ...submissionToDraftAdminRow(submission, input.userId, propertyId, {}),
    source: "text_setup" as const,
    importedAt: new Date().toISOString(),
  };
  const { error } = await db
    .from("manager_property_records")
    .upsert({ id: propertyId, manager_user_id: input.userId, status: "draft", row_data: row, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return { created: true, propertyId };
}

/* ------------------------------------------------------------------------------------------ */
/* The ONE text-listing draft writer                                                          */
/* ------------------------------------------------------------------------------------------ */

export type TextListingDraftInput = {
  /** The authenticated / proven account: never a value the texter typed. */
  userId: string;
  /** Opaque id of the text conversation; the draft id is deterministic per (user, flow), so a retry rewrites the same row. */
  flowId: string;
  address: string;
  roomCount: number;
  /** One rent for every room, or one per room. */
  rentsUsd: number[];
  details?: string | null;
  /** "Available now", "Dec 1": the words, written onto every room's availability. */
  availabilityText?: string | null;
  /** House rules as the landlord texted them (`houseRulesText`). */
  rulesText?: string | null;
  /** Public listing-photos URLs only (uploaded by `uploadListingPhotoBytes`); anything else is dropped. */
  photoUrls?: string[];
  workspaceId?: string | null;
};

export type SaveTextListingDraftResult = { ok: true; propertyId: string } | { ok: false; error: "changed_elsewhere" | "limit" | "save_failed" };

/**
 * Save (or re-save) a listing DRAFT from facts texted step by step. Both the assistant's `create_listing_draft_by_text` and
 * the new-landlord walkthrough (`signup/first-home.server.ts`) write through this and nothing else: same draft shape
 * (`submissionFromImportedProperty` + `submissionToDraftAdminRow`), `status: "draft"` (never public, never a listing slot,
 * `docs/agents/property-drafts.md`), and a draft someone already changed in PropLane is left alone. Publishing stays the
 * Add property wizard's (`POST /api/property-records`, with the plan cap and ownership rules).
 */
export async function saveTextListingDraft(db: SupabaseClient, input: TextListingDraftInput): Promise<SaveTextListingDraftResult> {
  const propertyId = draftIdFor(input.userId, input.flowId);
  const roomCount = Math.max(1, Math.min(20, Math.round(input.roomCount)));
  const rentFor = (index: number) => Math.round(input.rentsUsd.length === 1 ? input.rentsUsd[0]! : (input.rentsUsd[index] ?? input.rentsUsd[input.rentsUsd.length - 1]!));
  const submission = submissionFromImportedProperty({
    key: "text-listing",
    name: input.address,
    address: input.address,
    city: "",
    state: "",
    zip: "",
    propertyType: "house",
    rentByRoom: roomCount > 1,
    bedrooms: roomCount,
    bathrooms: null,
    monthlyRent: roomCount > 1 ? null : rentFor(0),
    deposit: null,
    rooms: roomCount > 1 ? Array.from({ length: roomCount }, (_, i) => ({ label: `Room ${i + 1}`, rent: rentFor(i), deposit: null, sourceRow: null })) : [],
    sourceSheet: "",
    sourceRows: [],
    needsLook: [],
    confidence: "medium",
  });
  if (input.details?.trim()) submission.houseOverview = input.details.trim();
  if (input.rulesText?.trim()) submission.houseRulesText = input.rulesText.trim().slice(0, 1200);
  if (input.availabilityText?.trim()) {
    const words = input.availabilityText.trim().slice(0, 60);
    submission.rooms = submission.rooms.map((room) => ({ ...room, availability: words }));
  }
  const photos = [...new Set((input.photoUrls ?? []).map((u) => normalizeListingPhotoUrl(u)).filter((u): u is string => Boolean(u)))].slice(0, 24);
  if (photos.length) submission.housePhotoDataUrls = [...new Set([...(submission.housePhotoDataUrls ?? []), ...photos])];

  const row = {
    ...submissionToDraftAdminRow(submission, input.userId, propertyId, {}),
    source: "text_setup" as const,
    importedAt: new Date().toISOString(),
  };
  const { data: existing } = await db.from("manager_property_records").select("manager_user_id, status").eq("id", propertyId).maybeSingle();
  if (existing && (String((existing as { manager_user_id?: unknown }).manager_user_id) !== input.userId || (existing as { status?: unknown }).status !== "draft")) {
    return { ok: false, error: "changed_elsewhere" };
  }
  const workspaceId = input.workspaceId?.trim();
  const { error } = await db.from("manager_property_records").upsert(
    {
      id: propertyId,
      manager_user_id: input.userId,
      status: "draft",
      row_data: row,
      property_data: null,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: error.message.includes("10 property records") ? "limit" : "save_failed" };
  return { ok: true, propertyId };
}
