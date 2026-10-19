import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { grantedHouses, type OwnerGrant } from "@/lib/property-owner/access.server";
import type { OwnerPropertyDetail, OwnerServiceRow } from "@/lib/property-owner/projection";
import { OwnerScopeError } from "@/lib/property-owner/summary.server";

const MAX_PHOTOS = 12;
const MAX_SERVICES = 25;

/** Only a public https image URL is a real photo: a `data:` blob or a relative path is dropped, and nothing is ever invented. */
export function ownerPhotoUrls(propertyData: unknown): string[] {
  const submission = ((propertyData ?? {}) as { listingSubmission?: unknown }).listingSubmission as
    | { housePhotoDataUrls?: unknown; rooms?: { photoDataUrls?: unknown }[] }
    | undefined;
  if (!submission) return [];
  const candidates: unknown[] = [];
  if (Array.isArray(submission.housePhotoDataUrls)) candidates.push(...submission.housePhotoDataUrls);
  for (const room of Array.isArray(submission.rooms) ? submission.rooms : []) {
    if (Array.isArray(room?.photoDataUrls)) candidates.push(...room.photoDataUrls);
  }
  const out: string[] = [];
  for (const candidate of candidates) {
    const url = typeof candidate === "string" ? candidate.trim() : "";
    if (/^https:\/\/[^\s]+$/i.test(url) && !out.includes(url)) out.push(url);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

/** "$1,250" or "1250.50" to cents, null when it is not an amount. */
export function ownerCostCents(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw * 100);
  const text = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function serviceStage(raw: unknown): OwnerServiceRow["stage"] {
  return raw === "completed" ? "completed" : raw === "scheduled" ? "scheduled" : "open";
}

/**
 * One house for the owner: its real listing photos and its services history. A house the owner was not granted is the same
 * 404 as one that does not exist. Services are the title, stage, day and cost, with no resident, vendor or unit.
 */
export async function loadOwnerPropertyDetail(db: SupabaseClient, grants: OwnerGrant[], propertyId: string): Promise<OwnerPropertyDetail> {
  const house = grantedHouses(grants, "performance").find((h) => h.propertyId === propertyId.trim());
  if (!house) throw new OwnerScopeError();

  const [record, orders] = await Promise.all([
    db.from("manager_property_records").select("property_data").eq("id", house.propertyId).eq("manager_user_id", house.managerUserId).maybeSingle(),
    db
      .from("portal_work_order_records")
      .select("id, row_data, created_at")
      .eq("manager_user_id", house.managerUserId)
      .eq("property_id", house.propertyId)
      .order("created_at", { ascending: false })
      .limit(MAX_SERVICES),
  ]);

  const services: OwnerServiceRow[] = [];
  for (const row of (orders.data ?? []) as { id: unknown; row_data: Record<string, unknown> | null }[]) {
    const data = row.row_data ?? {};
    const title = String(data.title ?? "").trim();
    if (!title) continue;
    const when = String(data.scheduledAtIso ?? "").slice(0, 10);
    services.push({
      id: String(row.id),
      title,
      stage: serviceStage(data.bucket),
      date: /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : null,
      costCents: ownerCostCents(data.cost),
    });
  }
  return { propertyId: house.propertyId, photos: ownerPhotoUrls(record.data?.property_data), services };
}
