import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOCUMENT_SELECT_COLUMNS,
  mapDocumentRow,
  type ManagerDocumentDTO,
  type ManagerDocumentRow,
  type ManagerDocumentVisibility,
} from "@/lib/documents/manager-documents";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

/** Rows a signed-in resident may read from the manager document library. */
export async function listSharedDocumentsForResident(
  db: SupabaseClient,
  userId: string,
  email: string,
): Promise<ManagerDocumentDTO[]> {
  const normalizedEmail = email.trim().toLowerCase();
  let query = db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq("visibility", "resident")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  const scope = orFilterForIdentity([
    ["resident_user_id", userId],
    ["resident_email", normalizedEmail],
  ]);
  // No identity means no documents — this filter is the boundary between two
  // residents of the same manager.
  query = scope ? query.or(scope) : query.eq("resident_user_id", "");

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as ManagerDocumentRow[] | null ?? []).map(mapDocumentRow);
}

/** Rows a signed-in vendor may read from linked managers' libraries. */
export async function listSharedDocumentsForVendor(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<ManagerDocumentDTO[]> {
  const { data: links, error: linkError } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("vendor_user_id", vendorUserId);
  if (linkError) throw new Error(linkError.message);

  const vendorIds = (links ?? []).map((r) => String(r.id)).filter(Boolean);
  if (vendorIds.length === 0) return [];

  const { data, error } = await db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq("visibility", "vendor")
    .in("vendor_id", vendorIds)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);
  return (data as ManagerDocumentRow[] | null ?? []).map(mapDocumentRow);
}

export async function getSharedDocumentForResident(
  db: SupabaseClient,
  documentId: string,
  userId: string,
  email: string,
): Promise<ManagerDocumentRow | null> {
  const rows = await listSharedDocumentsForResident(db, userId, email);
  const match = rows.find((r) => r.id === documentId);
  if (!match) return null;
  const { data, error } = await db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerDocumentRow | null) ?? null;
}

export async function getSharedDocumentForVendor(
  db: SupabaseClient,
  documentId: string,
  vendorUserId: string,
): Promise<ManagerDocumentRow | null> {
  const rows = await listSharedDocumentsForVendor(db, vendorUserId);
  if (!rows.some((r) => r.id === documentId)) return null;
  const { data, error } = await db
    .from("manager_documents")
    .select(DOCUMENT_SELECT_COLUMNS)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerDocumentRow | null) ?? null;
}

export function visibilityRequiresRecipient(visibility: ManagerDocumentVisibility): boolean {
  return visibility === "resident" || visibility === "vendor";
}
