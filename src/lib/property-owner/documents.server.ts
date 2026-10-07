import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createManagerDocumentSignedUrl, resolveDownloadName } from "@/lib/documents/document-signed-url.server";
import { UUID_PATTERN } from "@/lib/documents/manager-documents";
import { grantedHouses, type OwnerGrant } from "@/lib/property-owner/access.server";
import type { OwnerDocumentRow } from "@/lib/property-owner/projection";

/** Postgres "undefined column": the migration has not run here, so nothing is shared yet. */
const UNDEFINED_COLUMN = "42703";

/**
 * Library files the manager shared with owners, on houses this owner may open
 * documents for. A file with no house, an unshared file, a soft-deleted or
 * superseded version never qualifies. Only title, type, size and date go out.
 */
export async function loadOwnerDocuments(db: SupabaseClient, grants: OwnerGrant[]): Promise<OwnerDocumentRow[]> {
  const byManager = new Map<string, string[]>();
  for (const house of grantedHouses(grants, "documents")) {
    byManager.set(house.managerUserId, [...(byManager.get(house.managerUserId) ?? []), house.propertyId]);
  }
  const out: OwnerDocumentRow[] = [];
  for (const [managerUserId, propertyIds] of byManager) {
    const { data, error } = await db
      .from("manager_documents")
      .select("id, display_name, mime_type, size_bytes, created_at")
      .eq("manager_user_id", managerUserId)
      .in("property_id", propertyIds)
      .eq("shared_with_owners", true)
      .is("deleted_at", null)
      .is("superseded_by_document_id", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      if ((error as { code?: string }).code === UNDEFINED_COLUMN) continue;
      throw new Error("Could not load documents.");
    }
    for (const row of data ?? []) {
      out.push({
        id: String(row.id),
        title: String(row.display_name ?? "Document"),
        mimeType: String(row.mime_type ?? ""),
        sizeBytes: Number(row.size_bytes) || 0,
        createdAt: String(row.created_at ?? ""),
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * A server-minted, short-lived signed URL for ONE shared document, or null when
 * the owner may not open it. Every check is on the stored row: the id from the
 * URL is only a lookup key, and "not shared", "not your house", "deleted" and
 * "no such file" are all the same null.
 */
export async function mintOwnerDocumentUrl(
  db: SupabaseClient,
  grants: OwnerGrant[],
  documentId: string,
  download: boolean,
): Promise<{ url: string; mimeType: string; title: string; fileName?: string } | null> {
  if (!UUID_PATTERN.test(documentId)) return null;
  const { data: row, error } = await db
    .from("manager_documents")
    .select(
      "manager_user_id, property_id, storage_path, display_name, original_filename, mime_type, shared_with_owners, deleted_at, superseded_by_document_id",
    )
    .eq("id", documentId)
    .maybeSingle();
  if (error || !row) return null;
  // Same four tests the list applies, including the superseded one: a replaced
  // version is off the list, so its id must not keep minting bytes either.
  if (row.deleted_at || row.superseded_by_document_id || row.shared_with_owners !== true || !row.property_id) return null;
  const allowed = grantedHouses(grants, "documents").some(
    (h) => h.propertyId === row.property_id && h.managerUserId === row.manager_user_id,
  );
  if (!allowed) return null;
  const signed = await createManagerDocumentSignedUrl(db, row, download);
  if ("error" in signed) return null;
  return {
    url: signed.signedUrl,
    mimeType: String(row.mime_type ?? ""),
    title: String(row.display_name ?? "Document"),
    ...(download ? { fileName: resolveDownloadName(row) } : {}),
  };
}
