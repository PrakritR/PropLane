import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashShareToken, isMissingTokenHashColumn } from "@/lib/share-token-hash";
import {
  lookupRecordTestWorkspaceId,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";

export type PortalRecordShareKind = "lease" | "application";

export type PortalRecordShareLinkRow = {
  id: string;
  recordKind: PortalRecordShareKind;
  recordId: string;
  shareToken: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  accessCount: number;
};

function mapShareLinkRow(raw: Record<string, unknown>): PortalRecordShareLinkRow {
  return {
    id: String(raw.id),
    recordKind: String(raw.record_kind) as PortalRecordShareKind,
    recordId: String(raw.record_id),
    // Hash-only rows carry no raw token; the creator gets it once from `createPortalRecordShareLink`.
    shareToken: raw.share_token ? String(raw.share_token) : "",
    expiresAt: String(raw.expires_at),
    createdAt: String(raw.created_at),
    revokedAt: raw.revoked_at ? String(raw.revoked_at) : null,
    accessCount: Number(raw.access_count) || 0,
  };
}

function throwShareLinkDbError(error: { message: string; code?: string }): never {
  const err = new Error(error.message) as Error & { code?: string };
  err.code = error.code;
  throw err;
}

function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function buildPortalRecordShareUrl(origin: string, kind: PortalRecordShareKind, token: string): string {
  const base = origin.replace(/\/$/, "");
  const segment = kind === "lease" ? "leases" : "applications";
  return `${base}/share/${segment}/${encodeURIComponent(token)}`;
}

export async function createPortalRecordShareLink(
  db: SupabaseClient,
  input: {
    recordKind: PortalRecordShareKind;
    recordId: string;
    managerUserId: string;
    createdBy: string;
    expiresInDays?: number;
  },
): Promise<PortalRecordShareLinkRow> {
  // Clamp only AFTER confirming it is a real number: NaN survives Math.min/Math.max unchanged,
  // and `new Date(NaN).toISOString()` throws — an unhandled 500 from attacker-supplied JSON.
  const requestedDays = Number(input.expiresInDays);
  const expiresInDays = Number.isFinite(requestedDays) ? Math.min(90, Math.max(1, requestedDays)) : 14;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const shareToken = generateShareToken();
  const managerUserId = input.managerUserId.trim();
  if (!managerUserId) {
    throw new Error("managerUserId is required for portal_record_share_links");
  }

  // Keep the shared mint helper fail-closed even when a future caller forgets
  // the route-level gate. Authorization inputs are not provenance: re-derive
  // the durable owner, creator, and record namespace before issuing a bearer
  // capability.
  const createdBy = input.createdBy.trim();
  const [owner, creator, recordWorkspaceId] = await Promise.all([
    resolveTestWorkspaceClassification(managerUserId, db),
    resolveTestWorkspaceClassification(createdBy, db),
    lookupRecordTestWorkspaceId(
      input.recordKind === "lease" ? "portal_lease_pipeline_records" : "manager_application_records",
      input.recordId.trim(),
      db,
    ),
  ]);
  if (!createdBy || owner.kind === "classified" || creator.kind === "classified" || recordWorkspaceId) {
    throw new Error("Public share links are unavailable for this record.");
  }

  const base = {
    record_kind: input.recordKind,
    record_id: input.recordId.trim(),
    manager_user_id: managerUserId,
    expires_at: expiresAt,
    created_by: createdBy,
  };
  const columns = "id, record_kind, record_id, expires_at, created_at, revoked_at, access_count";
  // Only the hash is stored. If the hash column is not there yet (code ahead of its migration) the
  // legacy raw column is used so link creation never breaks; the migration makes it read-only.
  let { data, error } = await db
    .from("portal_record_share_links")
    .insert({ ...base, token_hash: hashShareToken(shareToken) })
    .select(columns)
    .single();
  if (error && isMissingTokenHashColumn(error)) {
    ({ data, error } = await db
      .from("portal_record_share_links")
      .insert({ ...base, share_token: shareToken })
      .select(columns)
      .single());
  }

  if (error) throwShareLinkDbError(error);
  // The raw token goes back to the creator once; it is never read from the database again.
  return { ...mapShareLinkRow(data as Record<string, unknown>), shareToken };
}

export type ResolvedPortalRecordShareLink = {
  link: PortalRecordShareLinkRow;
  recordOwnerUserId: string;
  createdBy: string;
};

/** Resolve a public share token (no auth). */
export async function resolvePortalRecordShareToken(
  db: SupabaseClient,
  token: string,
): Promise<ResolvedPortalRecordShareLink | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const linkColumns =
    "id, record_kind, record_id, expires_at, created_at, revoked_at, access_count, manager_user_id, created_by";
  // Hash first. A row from before the migration is also found by its legacy raw column until that
  // column is retired; a database without the hash column answers from the raw column alone.
  let { data: linkRow, error } = await db
    .from("portal_record_share_links")
    .select(linkColumns)
    .eq("token_hash", hashShareToken(trimmed))
    .is("revoked_at", null)
    .maybeSingle();
  if (!linkRow && (!error || isMissingTokenHashColumn(error))) {
    ({ data: linkRow, error } = await db
      .from("portal_record_share_links")
      .select(linkColumns)
      .eq("share_token", trimmed)
      .is("revoked_at", null)
      .maybeSingle());
  }

  if (error || !linkRow) return null;
  if (new Date(String(linkRow.expires_at)).getTime() < Date.now()) return null;

  // A public bearer token must never bridge into a private test namespace,
  // including a token issued before the account was suspended or the feature
  // was disabled. Link rows predate durable provenance, so check both stored
  // principals and the current record rather than trusting the token alone.
  const [owner, creator, recordWorkspaceId] = await Promise.all([
    resolveTestWorkspaceClassification(String(linkRow.manager_user_id ?? ""), db),
    resolveTestWorkspaceClassification(String(linkRow.created_by ?? ""), db),
    lookupRecordTestWorkspaceId(
      String(linkRow.record_kind) === "lease" ? "portal_lease_pipeline_records" : "manager_application_records",
      String(linkRow.record_id ?? ""),
      db,
    ),
  ]);
  if (owner.kind === "classified" || creator.kind === "classified" || recordWorkspaceId) return null;

  await db
    .from("portal_record_share_links")
    .update({
      access_count: (Number(linkRow.access_count) || 0) + 1,
      last_accessed_at: new Date().toISOString(),
    })
    .eq("id", linkRow.id);

  return {
    link: mapShareLinkRow(linkRow as Record<string, unknown>),
    recordOwnerUserId: String(linkRow.manager_user_id),
    createdBy: linkRow.created_by ? String(linkRow.created_by) : "",
  };
}

/** Revoke all active share links for one record (manager auth). */
export async function revokePortalRecordShareLinks(
  db: SupabaseClient,
  input: {
    recordKind: PortalRecordShareKind;
    recordId: string;
    managerUserId: string;
  },
): Promise<number> {
  const { data, error } = await db
    .from("portal_record_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("record_kind", input.recordKind)
    .eq("record_id", input.recordId.trim())
    .eq("manager_user_id", input.managerUserId)
    .is("revoked_at", null)
    .select("id");

  if (error) throwShareLinkDbError(error);
  return data?.length ?? 0;
}
