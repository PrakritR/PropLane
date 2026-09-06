import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { APPLICATION_DOCUMENTS_BUCKET } from "../../src/lib/rental-application/application-photos";
import { applicationPhotoFolderKey, isPathInApplicationFolder } from "../../src/lib/rental-application/application-photos.server";
import { createApplicationDocumentUploadEncryption, decryptApplicationDocumentBytes } from "../../src/lib/security/application-document-crypto.server";
import { APPLICATION_DOCUMENT_STORAGE_MIME, applicationDocumentAad, encryptApplicationDocumentUpload } from "../../src/lib/security/application-document-format";

export type DocumentBackfillDatabase = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

/** One object at a time: lock its application, verify replacement, commit alias, then remove original. */
export async function migrateApplicationDocumentObject(
  db: DocumentBackfillDatabase,
  storage: SupabaseClient,
  applicationId: string,
  sourcePath: string,
  apply: boolean,
): Promise<"candidate" | "migrated" | "cleanup-pending" | "application-deleted"> {
  if (!isPathInApplicationFolder(sourcePath, applicationId) || sourcePath.endsWith(".penc")) throw new Error("Invalid migration source.");
  const match = /\.(jpg|png|webp|heic|heif|pdf)$/.exec(sourcePath);
  if (!match) throw new Error("Unsupported legacy document.");
  const bucket = storage.storage.from(APPLICATION_DOCUMENTS_BUCKET);
  let uploadedPath: string | null = null;
  let encryptedPath: string | null = null;
  let commitAttempted = false;
  let committed = false;
  await db.query(apply ? "begin" : "begin read only");
  try {
    await db.query("set local role postgres");
    await db.query("set local lock_timeout = '5s'");
    await db.query("set local statement_timeout = '30s'");
    const parent = await db.query(`select id from public.manager_application_records where id = $1${apply ? " for update" : ""}`, [applicationId]);
    if (!parent.rows.length) {
      await db.query("rollback");
      return "application-deleted";
    }
    const aliases = await db.query("select encrypted_path from public.application_document_storage_aliases where source_path = $1 and application_id = $2", [sourcePath, applicationId]);
    const existing = aliases.rows[0]?.encrypted_path;
    if (existing !== undefined) {
      if (typeof existing !== "string" || !isPathInApplicationFolder(existing, applicationId)) throw new Error("Invalid migration alias.");
      applicationDocumentAad(existing);
      encryptedPath = existing;
      const replacement = await bucket.download(existing);
      if (replacement.error || !replacement.data) throw new Error("Could not verify migrated document.");
      decryptApplicationDocumentBytes(Buffer.from(await replacement.data.arrayBuffer()), existing);
    } else {
      const source = await bucket.download(sourcePath);
      if (source.error || !source.data) throw new Error("Could not read legacy document.");
      const bytes = Buffer.from(await source.data.arrayBuffer());
      encryptedPath = `application/${applicationPhotoFolderKey(applicationId)}/migration-${randomUUID()}.${match[1]}.penc`;
      const encryption = createApplicationDocumentUploadEncryption(encryptedPath, bytes.length);
      const ciphertext = await encryptApplicationDocumentUpload(new Blob([new Uint8Array(bytes)]), encryptedPath, encryption);
      // Dry run validates encryption configuration without changing either data store.
      if (apply) {
        const upload = await bucket.upload(encryptedPath, ciphertext, { contentType: APPLICATION_DOCUMENT_STORAGE_MIME, upsert: false });
        if (upload.error) throw new Error("Could not upload protected document.");
        uploadedPath = encryptedPath;
        const verification = await bucket.download(encryptedPath);
        if (verification.error || !verification.data ||
            !decryptApplicationDocumentBytes(Buffer.from(await verification.data.arrayBuffer()), encryptedPath).equals(bytes)) {
          throw new Error("Protected document verification failed.");
        }
        await db.query("insert into public.application_document_storage_aliases (source_path, application_id, encrypted_path) values ($1, $2, $3)", [sourcePath, applicationId, encryptedPath]);
      }
    }
    if (!apply) {
      await db.query("rollback");
      return "candidate";
    }
    commitAttempted = true;
    await db.query("commit");
    committed = true;
  } catch {
    await db.query("rollback").catch(() => undefined);
    // A lost COMMIT response is ambiguous: the alias may already be durable.
    // Keep its ciphertext and let a later run reconcile, never create a broken alias.
    if (uploadedPath && !commitAttempted) await bucket.remove([uploadedPath]).catch(() => undefined);
    throw new Error("Document migration failed; original bytes retained. Reconcile committed aliases before cleanup.");
  }
  if (!committed || !encryptedPath) throw new Error("Document migration did not commit.");
  const removed = await bucket.remove([sourcePath]).catch(() => ({ error: true }));
  if (removed.error) return "cleanup-pending";
  await db.query("begin");
  try {
    await db.query("set local role postgres");
    await db.query("set local statement_timeout = '30s'");
    await db.query("update public.application_document_storage_aliases set source_removed_at = now() where source_path = $1 and encrypted_path = $2", [sourcePath, encryptedPath]);
    await db.query("commit");
  } catch {
    await db.query("rollback").catch(() => undefined);
    throw new Error("Document migrated; cleanup bookkeeping requires reconciliation.");
  }
  return "migrated";
}
