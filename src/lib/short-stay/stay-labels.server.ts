import "server-only";

/**
 * The owner's address and the human labels of a stay's house and room. Shared by the host's answer
 * (`hold-decisions.server.ts`), the guest's booking and the paid early check-in / late checkout add-ons
 * so none of them read these twice differently.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function loadOwnerIdentity(db: SupabaseClient, ownerId: string): Promise<{ email: string; name: string }> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", ownerId).maybeSingle();
  return { email: String(data?.email ?? "").trim().toLowerCase(), name: String(data?.full_name ?? "").trim() };
}

export async function loadStayLabels(db: SupabaseClient, propertyId: string, roomId: string): Promise<{ propertyLabel: string; roomLabel: string }> {
  const fallback = { propertyLabel: "the house", roomLabel: "your room" };
  if (!propertyId) return fallback;
  const { data } = await db.from("manager_property_records").select("property_data").eq("id", propertyId).maybeSingle();
  const property = asRecord(data?.property_data) as { title?: string; buildingName?: string; address?: string; listingSubmission?: { rooms?: Array<{ id?: string; name?: string }> } };
  const rooms = property.listingSubmission?.rooms ?? [];
  const index = rooms.findIndex((room) => room.id === roomId);
  return {
    propertyLabel: (property.buildingName || property.title || property.address || fallback.propertyLabel).trim(),
    roomLabel: index >= 0 ? rooms[index]?.name?.trim() || `Room ${index + 1}` : fallback.roomLabel,
  };
}
