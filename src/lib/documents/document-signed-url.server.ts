import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOCUMENT_MIME_EXTENSIONS,
  MANAGER_DOCUMENTS_BUCKET,
  documentStoragePathBelongsToOwner,
} from "@/lib/documents/manager-documents";

export const DOCUMENT_SIGNED_URL_TTL_SECONDS = 600;

export function resolveDownloadName(row: {
  display_name: string;
  original_filename: string | null;
  storage_path: string;
  mime_type: string;
}): string {
  const original = (row.original_filename ?? "").trim();
  if (original) return original;
  const display = row.display_name;
  if (/\.[a-z0-9]{1,8}$/i.test(display)) return display;
  const pathExt = /\.([a-z0-9]{1,8})$/i.exec(row.storage_path)?.[1];
  const ext = pathExt ?? DOCUMENT_MIME_EXTENSIONS[row.mime_type];
  return ext ? `${display}.${ext}` : display;
}

export async function createManagerDocumentSignedUrl(
  db: SupabaseClient,
  row: {
    manager_user_id: string | null;
    storage_path: string;
    display_name: string;
    original_filename: string | null;
    mime_type: string;
  },
  download: boolean,
): Promise<{ signedUrl: string } | { error: string }> {
  // The caller has authorized the ROW; this asserts the row's path matches the
  // row's owner before the service-role client signs it. See
  // `documentStoragePathBelongsToOwner` for why that is not redundant with RLS.
  // Reported as "not found" so a mismatched row is indistinguishable from a
  // missing one, matching how the routes deny everything else.
  if (!documentStoragePathBelongsToOwner(row.storage_path, row.manager_user_id)) {
    return { error: "Document not found." };
  }

  const { data: signed, error: signError } = await db.storage
    .from(MANAGER_DOCUMENTS_BUCKET)
    .createSignedUrl(row.storage_path, DOCUMENT_SIGNED_URL_TTL_SECONDS, download ? { download: resolveDownloadName(row) } : undefined);

  if (signError || !signed?.signedUrl) {
    return { error: signError?.message ?? "Failed to sign URL." };
  }
  return { signedUrl: signed.signedUrl };
}
