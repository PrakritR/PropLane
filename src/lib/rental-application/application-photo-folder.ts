import { normalizeApplicationAxisId } from "./application-axis-id";

/** The canonical application document folder encoder, independent of authorization loaders. */
export function applicationPhotoFolderKey(applicationId: string): string {
  const normalized = normalizeApplicationAxisId(applicationId) || applicationId.trim();
  return normalized.toUpperCase().replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}
