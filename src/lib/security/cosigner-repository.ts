import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerEncryptionOwner, openCosignerIdentity, sealCosignerIdentity } from "./cosigner-identity";

export type ScopedCosignerRecord = {
  id: string;
  signerAppId: string;
  managerUserId: string | null;
  encryptionOwnerId: string;
  signerRow: DemoApplicantRow;
  submission: CosignerSubmission;
};

/** Screening receives the canonical owner from its authenticated/verified caller. */
export async function loadOwnedCosignerRecord(db: SupabaseClient, recordId: string, expectedManagerId: string): Promise<ScopedCosignerRecord | null> {
  if (!expectedManagerId.trim()) return null;
  const { data, error } = await db.from("cosigner_submission_records")
    .select("id, signer_app_id, manager_user_id, row_data").eq("id", recordId).maybeSingle();
  if (error) throw new Error("Could not load protected co-signer record.");
  if (!data?.row_data) return null;
  const parent = await db.from("manager_application_records")
    .select("manager_user_id, row_data").eq("id", data.signer_app_id).maybeSingle();
  if (parent.error) throw new Error("Could not authorize protected co-signer record.");
  if (!parent.data?.row_data) return null;
  const row = parent.data.row_data as DemoApplicantRow;
  // A null current owner is a real unassigned state, never a legacy fallback.
  const owner = typeof parent.data.manager_user_id === "string" ? parent.data.manager_user_id.trim() : "";
  if (!owner || owner !== expectedManagerId) return null;
  return {
    id: String(data.id), signerAppId: String(data.signer_app_id), managerUserId: owner,
    encryptionOwnerId: cosignerEncryptionOwner(data.row_data, owner),
    signerRow: { ...row, managerUserId: owner },
    submission: openCosignerIdentity(data.row_data, String(data.id)),
  };
}

export async function persistOwnedCosignerRecord(db: SupabaseClient, record: ScopedCosignerRecord): Promise<void> {
  // Re-resolve current parent ownership and cryptographic metadata before writing.
  const current = await loadOwnedCosignerRecord(db, record.id, record.managerUserId ?? "");
  if (!current || current.signerAppId !== record.signerAppId) throw new Error("Co-signer access is no longer available.");
  const { error } = await db.from("cosigner_submission_records").update({
    row_data: sealCosignerIdentity(record.submission, record.id, current.encryptionOwnerId),
    updated_at: new Date().toISOString(),
  }).eq("id", record.id).eq("signer_app_id", current.signerAppId);
  if (error) throw new Error("Could not persist protected co-signer record.");
}
