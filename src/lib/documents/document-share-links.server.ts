import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { hashShareToken, isMissingTokenHashColumn } from "@/lib/share-token-hash";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DocumentShareLinkRow = {
  id: string;
  documentId: string;
  shareToken: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  accessCount: number;
};

function mapShareLinkRow(raw: Record<string, unknown>): DocumentShareLinkRow {
  return {
    id: String(raw.id),
    documentId: String(raw.document_id),
    // Hash-only rows carry no raw token; the creator gets it once from `createDocumentShareLink`.
    shareToken: raw.share_token ? String(raw.share_token) : "",
    expiresAt: String(raw.expires_at),
    createdAt: String(raw.created_at),
    revokedAt: raw.revoked_at ? String(raw.revoked_at) : null,
    accessCount: Number(raw.access_count) || 0,
  };
}

function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function buildDocumentShareUrl(origin: string, token: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/share/documents/${encodeURIComponent(token)}`;
}

/** Create an expiring share link for a document. */
export async function createDocumentShareLink(
  db: SupabaseClient,
  input: {
    documentId: string;
    managerUserId: string;
    createdBy: string;
    expiresInDays?: number;
  },
): Promise<DocumentShareLinkRow> {
  const expiresInDays = Math.min(90, Math.max(1, input.expiresInDays ?? 7));
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const shareToken = generateShareToken();

  const base = {
    document_id: input.documentId,
    manager_user_id: input.managerUserId,
    expires_at: expiresAt,
    created_by: input.createdBy,
  };
  const columns = "id, document_id, expires_at, created_at, revoked_at, access_count";
  // Only the hash is stored (see portal-record-share-links.server.ts for the fallback rationale).
  let { data, error } = await db
    .from("document_share_links")
    .insert({ ...base, token_hash: hashShareToken(shareToken) })
    .select(columns)
    .single();
  if (error && isMissingTokenHashColumn(error)) {
    ({ data, error } = await db
      .from("document_share_links")
      .insert({ ...base, share_token: shareToken })
      .select(columns)
      .single());
  }

  if (error) throw new Error(error.message);
  // The raw token goes back to the creator once; it is never read from the database again.
  return { ...mapShareLinkRow(data as Record<string, unknown>), shareToken };
}

/** Revoke an active share link. */
export async function revokeDocumentShareLink(
  db: SupabaseClient,
  input: { linkId: string; managerUserId: string },
): Promise<void> {
  const { error } = await db
    .from("document_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.linkId)
    .eq("manager_user_id", input.managerUserId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export type ResolvedShareLink = {
  link: DocumentShareLinkRow;
  document: {
    id: string;
    displayName: string;
    mimeType: string;
    storagePath: string;
    managerUserId: string;
  };
};

/** Resolve a public share token to document metadata (no auth). */
export async function resolveDocumentShareToken(
  db: SupabaseClient,
  token: string,
): Promise<ResolvedShareLink | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const linkColumns = "id, document_id, expires_at, created_at, revoked_at, access_count, manager_user_id";
  let { data: linkRow, error } = await db
    .from("document_share_links")
    .select(linkColumns)
    .eq("token_hash", hashShareToken(trimmed))
    .is("revoked_at", null)
    .maybeSingle();
  if (!linkRow && (!error || isMissingTokenHashColumn(error))) {
    ({ data: linkRow, error } = await db
      .from("document_share_links")
      .select(linkColumns)
      .eq("share_token", trimmed)
      .is("revoked_at", null)
      .maybeSingle());
  }

  if (error || !linkRow) return null;
  if (new Date(String(linkRow.expires_at)).getTime() < Date.now()) return null;

  const { data: doc } = await db
    .from("manager_documents")
    .select("id, display_name, mime_type, storage_path, manager_user_id, deleted_at")
    .eq("id", linkRow.document_id)
    .maybeSingle();

  if (!doc || doc.deleted_at) return null;
  if (String(doc.manager_user_id) !== String(linkRow.manager_user_id)) return null;

  await db
    .from("document_share_links")
    .update({
      access_count: (Number(linkRow.access_count) || 0) + 1,
      last_accessed_at: new Date().toISOString(),
    })
    .eq("id", linkRow.id);

  return {
    link: mapShareLinkRow(linkRow as Record<string, unknown>),
    document: {
      id: String(doc.id),
      displayName: String(doc.display_name),
      mimeType: String(doc.mime_type),
      storagePath: String(doc.storage_path),
      managerUserId: String(doc.manager_user_id),
    },
  };
}

/** List active share links for a document. */
export async function listDocumentShareLinks(
  db: SupabaseClient,
  input: { documentId: string; managerUserId: string },
): Promise<DocumentShareLinkRow[]> {
  const { data, error } = await db
    .from("document_share_links")
    .select("id, document_id, share_token, expires_at, created_at, revoked_at, access_count")
    .eq("document_id", input.documentId)
    .eq("manager_user_id", input.managerUserId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapShareLinkRow(row as Record<string, unknown>));
}

export function hashShareTokenForAudit(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
