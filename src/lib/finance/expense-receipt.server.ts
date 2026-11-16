import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANAGER_DOCUMENTS_BUCKET,
  MAX_DOCUMENT_BYTES,
  buildDocumentStoragePath,
  extensionForMime,
  isAllowedDocumentMime,
  sanitizeDisplayName,
} from "@/lib/documents/manager-documents";
import { createManagerDocumentSignedUrl, resolveDownloadName } from "@/lib/documents/document-signed-url.server";
import { rowAllowedInWorkspaceScope, type WorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

/**
 * A financial entry's receipt: ONE `manager_documents` row (category `invoice`) in the PRIVATE
 * `manager-documents` bucket, linked from `manager_expense_entries.receipt_document_id`. The entry stores the
 * document's id, never a path or URL; bytes are reachable only through `signedReceiptUrl`, which mints a
 * short-lived signed URL after proving the entry is the caller's and inside the active workspace.
 */

export type ReceiptResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

type ExpenseRef = { id: string; property_id: string | null; vendor_id: string | null; memo: string | null; receipt_document_id: string | null };

async function loadOwnedExpense(
  db: SupabaseClient,
  managerUserId: string,
  expenseId: string,
  scope: WorkspaceRowScope,
): Promise<ReceiptResult<ExpenseRef>> {
  const { data, error } = await db
    .from("manager_expense_entries")
    .select("id, property_id, vendor_id, memo, receipt_document_id")
    .eq("id", expenseId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  // A foreign, missing or out-of-workspace entry is one and the same 404: the boundary leaks nothing.
  if (!data || !rowAllowedInWorkspaceScope(scope, (data as ExpenseRef).property_id)) {
    return { ok: false, status: 404, error: "Expense not found." };
  }
  return { ok: true, value: data as ExpenseRef };
}

export async function attachExpenseReceipt(
  db: SupabaseClient,
  managerUserId: string,
  expenseId: string,
  scope: WorkspaceRowScope,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<ReceiptResult<{ documentId: string }>> {
  if (!isAllowedDocumentMime(file.mime)) return { ok: false, status: 415, error: `Unsupported file type: ${file.mime}.` };
  if (file.bytes.byteLength === 0) return { ok: false, status: 400, error: "Empty file." };
  if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, status: 413, error: "File exceeds the 25 MB limit." };
  const expense = await loadOwnedExpense(db, managerUserId, expenseId, scope);
  if (!expense.ok) return expense;

  const ext = extensionForMime(file.mime, file.name);
  const storagePath = buildDocumentStoragePath(managerUserId, ext, `receipt-${Date.now()}-${randomUUID()}`);
  const { error: uploadError } = await db.storage
    .from(MANAGER_DOCUMENTS_BUCKET)
    .upload(storagePath, file.bytes, { contentType: file.mime, upsert: false });
  if (uploadError) return { ok: false, status: 500, error: uploadError.message };

  const { data: doc, error: docError } = await db
    .from("manager_documents")
    .insert({
      manager_user_id: managerUserId,
      display_name: sanitizeDisplayName(`Receipt - ${expense.value.memo ?? file.name}`, "Receipt"),
      original_filename: file.name || null,
      mime_type: file.mime,
      size_bytes: file.bytes.byteLength,
      checksum: createHash("sha256").update(file.bytes).digest("hex"),
      storage_path: storagePath,
      category: "invoice",
      property_id: expense.value.property_id,
      vendor_id: null,
      visibility: "manager",
      uploaded_by: managerUserId,
    })
    .select("id")
    .single();
  if (docError || !doc?.id) {
    await db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove([storagePath]);
    return { ok: false, status: 500, error: docError?.message ?? "Failed to save the receipt." };
  }

  const { error: linkError } = await db
    .from("manager_expense_entries")
    .update({ receipt_document_id: String(doc.id), updated_at: new Date().toISOString() })
    .eq("id", expenseId)
    .eq("manager_user_id", managerUserId);
  if (linkError) {
    await db.from("manager_documents").delete().eq("id", String(doc.id));
    await db.storage.from(MANAGER_DOCUMENTS_BUCKET).remove([storagePath]);
    return { ok: false, status: 500, error: linkError.message };
  }
  return { ok: true, value: { documentId: String(doc.id) } };
}

export async function signedReceiptUrl(
  db: SupabaseClient,
  managerUserId: string,
  expenseId: string,
  scope: WorkspaceRowScope,
  download: boolean,
): Promise<ReceiptResult<{ url: string; fileName: string; mimeType: string }>> {
  const expense = await loadOwnedExpense(db, managerUserId, expenseId, scope);
  if (!expense.ok) return expense;
  const documentId = expense.value.receipt_document_id;
  if (!documentId) return { ok: false, status: 404, error: "No receipt on this entry." };
  const { data: row, error } = await db
    .from("manager_documents")
    .select("manager_user_id, storage_path, display_name, original_filename, mime_type")
    .eq("id", documentId)
    .eq("manager_user_id", managerUserId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!row) return { ok: false, status: 404, error: "No receipt on this entry." };
  const signed = await createManagerDocumentSignedUrl(db, row as never, download);
  if ("error" in signed) return { ok: false, status: 500, error: signed.error };
  return { ok: true, value: { url: signed.signedUrl, fileName: resolveDownloadName(row as never), mimeType: String((row as { mime_type: string }).mime_type) } };
}
