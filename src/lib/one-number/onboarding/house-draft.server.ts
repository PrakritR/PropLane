import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { submissionToDraftAdminRow } from "@/lib/demo-admin-property-inventory";
import type { HouseHints } from "@/lib/one-number/onboarding/role-detect";
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
