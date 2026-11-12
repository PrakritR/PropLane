import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { shortLabel, type CatalogProperty, type CatalogRoom } from "@/lib/manager-sms-commands/resolve-target";
import { loadWorkspaceById } from "@/lib/workspaces/active.server";

const HIDDEN_STATUSES = new Set(["rejected", "archived", "deleted"]);

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One record -> the few facts the resolver reads. The submission wins over the legacy card for rooms. */
export function catalogPropertyFromRow(
  row: { id: unknown; status: unknown; row_data: unknown; property_data: unknown },
  owner: { workspaceId: string; ownerUserId: string },
): CatalogProperty | null {
  const id = text(row.id);
  if (!id) return null;
  const status = text(row.status);
  if (HIDDEN_STATUSES.has(status)) return null;
  const prop = obj(row.property_data);
  const raw = obj(row.row_data);
  const submission = obj(prop?.listingSubmission) ?? obj(raw?.submission);
  const src = prop ?? raw;
  const address = text(submission?.address) || text(src?.address);
  const title = text(submission?.buildingName) || text(src?.buildingName) || text(src?.title);
  const rooms: CatalogRoom[] = (Array.isArray(submission?.rooms) ? (submission!.rooms as unknown[]) : [])
    .map((entry) => obj(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry, index) => ({
      id: text(entry.id) || `room-${index + 1}`,
      name: text(entry.name) || `Room ${index + 1}`,
      rentUsd: typeof entry.monthlyRent === "number" && entry.monthlyRent > 0 ? entry.monthlyRent : null,
    }));
  return { id, status, label: shortLabel(address, title), title, rooms, workspaceId: owner.workspaceId, ownerUserId: owner.ownerUserId };
}

/** Every listing of the workspaces this verified phone may run. A failed read returns null: the caller says nothing, never guesses. */
export async function loadCommandCatalog(db: SupabaseClient, workspaceIds: string[]): Promise<CatalogProperty[] | null> {
  const out: CatalogProperty[] = [];
  for (const workspaceId of [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))]) {
    const workspace = await loadWorkspaceById(db, workspaceId);
    if (!workspace) continue;
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, status, row_data, property_data")
      .eq("workspace_id", workspace.id)
      .eq("manager_user_id", workspace.ownerUserId)
      .limit(200);
    if (error) return null;
    for (const row of data ?? []) {
      const property = catalogPropertyFromRow(row, { workspaceId: workspace.id, ownerUserId: workspace.ownerUserId });
      if (property) out.push(property);
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
