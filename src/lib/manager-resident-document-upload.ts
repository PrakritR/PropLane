import type { ResidentUploadDocKind } from "@/components/portal/manager-resident-upload-modal";
import {
  type ManagerDocumentCategory,
  type ManagerDocumentDTO,
} from "@/lib/documents/manager-documents";

export function residentUploadKindToCategory(kind: ResidentUploadDocKind): ManagerDocumentCategory {
  switch (kind) {
    case "lease":
      return "lease";
    case "inspection":
      return "inspection";
    case "payment":
      return "invoice";
    case "application":
    case "other":
    default:
      return "other";
  }
}

export type ResidentDocumentUploadScope = {
  residentEmail: string;
  residentUserId?: string | null;
  propertyId?: string | null;
  leaseId?: string | null;
};

/** Upload one file to the manager document library scoped to this resident. */
export async function uploadManagerDocumentForResident(
  file: File,
  kind: ResidentUploadDocKind,
  scope: ResidentDocumentUploadScope,
): Promise<ManagerDocumentDTO> {
  const form = new FormData();
  form.set("file", file);
  form.set("displayName", file.name.replace(/\.[^.]+$/, "") || file.name);
  form.set("category", residentUploadKindToCategory(kind));
  form.set("visibility", "resident");
  const email = scope.residentEmail.trim().toLowerCase();
  if (email) form.set("residentEmail", email);
  if (scope.residentUserId?.trim()) form.set("residentUserId", scope.residentUserId.trim());
  if (scope.propertyId?.trim()) form.set("propertyId", scope.propertyId.trim());
  if (scope.leaseId?.trim()) form.set("leaseId", scope.leaseId.trim());

  const res = await fetch("/api/manager-documents", { method: "POST", body: form, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Upload failed.");
  }
  return data.document as ManagerDocumentDTO;
}
