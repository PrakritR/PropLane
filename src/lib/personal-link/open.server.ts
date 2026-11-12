import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { propertyBelongsToWorkspace } from "@/lib/one-number/link-destinations.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { parsePersonalLinkTarget, PERSONAL_LINK_TARGET_TYPE, type PersonalAccountPrefill } from "./model";

type Row = Record<string, unknown>;

export function maskLast4(phoneKey: string): string {
  return `•••• ${phoneKey.replace(/\D/g, "").slice(-4)}`;
}

export type PersonalLinkOpen =
  | { ok: true; workspaceId: string; propertyId: string | null; prefill: PersonalAccountPrefill }
  | { ok: false };

/**
 * What a personal account link points at, re-derived live from the link row. The home must still belong to the link's
 * workspace; a home that moved or was removed since the link went out simply loses its label (the link still opens an
 * account, which is the point), but a workspace that no longer exists reads as gone.
 */
export async function openPersonalAccountLink(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "purpose" | "targetType" | "targetId" | "workspaceId" | "phoneKey">,
): Promise<PersonalLinkOpen> {
  if (link.purpose !== "account" || link.targetType !== PERSONAL_LINK_TARGET_TYPE || !link.workspaceId) return { ok: false };
  const target = parsePersonalLinkTarget(link.targetId);
  if (!target || target.workspaceId !== link.workspaceId) return { ok: false };
  const { data: workspace, error } = await db.from("portal_workspaces").select("id").eq("id", link.workspaceId).maybeSingle();
  if (error || !workspace) return { ok: false };

  let houseLabel = "";
  let propertyId = target.propertyId;
  if (propertyId) {
    if (await propertyBelongsToWorkspace(db, propertyId, link.workspaceId)) {
      const { data } = await db.from("manager_property_records").select("property_data, row_data").eq("id", propertyId).maybeSingle();
      const row = (data ?? {}) as Row;
      houseLabel = propertyLabel(row.property_data) || propertyLabel(row.row_data);
    } else {
      propertyId = null;
    }
  }
  return { ok: true, workspaceId: link.workspaceId, propertyId, prefill: { houseLabel, maskedPhone: maskLast4(link.phoneKey) } };
}
