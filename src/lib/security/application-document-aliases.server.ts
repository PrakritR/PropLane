import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPathInApplicationFolder } from "@/lib/rental-application/application-photos.server";
import { APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX, applicationDocumentAad } from "./application-document-format";

/** Authorize the ORIGINAL stored attachment before calling. An alias never grants access. */
export async function resolveApplicationDocumentStoragePath(
  db: SupabaseClient,
  applicationId: string,
  originalPath: string,
): Promise<string> {
  if (!isPathInApplicationFolder(originalPath, applicationId)) throw new Error("Invalid application document path.");
  if (originalPath.endsWith(APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX)) {
    applicationDocumentAad(originalPath);
    return originalPath;
  }
  const { data, error } = await db.from("application_document_storage_aliases")
    .select("encrypted_path").eq("source_path", originalPath).eq("application_id", applicationId).maybeSingle();
  // Never quietly fall back to legacy bytes when alias state is unreadable.
  if (error) throw new Error("Application document migration state is unavailable.");
  if (!data) return originalPath;
  if (typeof data.encrypted_path !== "string" || !isPathInApplicationFolder(data.encrypted_path, applicationId)) {
    throw new Error("Invalid application document migration state.");
  }
  applicationDocumentAad(data.encrypted_path);
  return data.encrypted_path;
}
