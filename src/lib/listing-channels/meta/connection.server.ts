import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/security/data-encryption";
import type { MetaManagedPage } from "@/lib/listing-channels/meta/graph.server";

export type MetaConnectionPublic = {
  connected: boolean;
  pageName: string | null;
  igUsername: string | null;
  revoked: boolean;
};

export type MetaConnection = MetaConnectionPublic & {
  workspaceId: string;
  managerUserId: string;
  pageId: string | null;
  igAccountId: string | null;
  pageToken: string;
};

function supabaseProjectRef(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

function tokenContext(managerUserId: string, workspaceId: string) {
  return { purpose: "meta-page-token", ownerId: managerUserId, recordId: workspaceId, field: "pageToken" };
}

export const EMPTY_META_CONNECTION: MetaConnectionPublic = { connected: false, pageName: null, igUsername: null, revoked: false };

/** What the browser may see: never the token. A table that is not migrated yet reads as "not connected". */
export async function loadMetaConnectionPublic(db: SupabaseClient, workspaceId: string): Promise<MetaConnectionPublic> {
  const { data, error } = await db
    .from("listing_channel_connections")
    .select("page_name, ig_username, revoked, project_ref")
    .eq("workspace_id", workspaceId)
    .eq("provider", "meta")
    .maybeSingle();
  if (error || !data) return EMPTY_META_CONNECTION;
  const sameProject = !data.project_ref || data.project_ref === supabaseProjectRef();
  return {
    connected: sameProject && data.revoked !== true,
    pageName: (data.page_name as string | null) ?? null,
    igUsername: (data.ig_username as string | null) ?? null,
    revoked: data.revoked === true,
  };
}

/** The decrypted connection, server-side only. Null when absent, revoked, or authorized against another database. */
export async function loadMetaConnection(db: SupabaseClient, workspaceId: string): Promise<MetaConnection | null> {
  const { data, error } = await db
    .from("listing_channel_connections")
    .select("workspace_id, manager_user_id, page_id, page_name, ig_account_id, ig_username, page_token_encrypted, revoked, project_ref")
    .eq("workspace_id", workspaceId)
    .eq("provider", "meta")
    .maybeSingle();
  if (error || !data || data.revoked === true) return null;
  if (data.project_ref && data.project_ref !== supabaseProjectRef()) return null;
  const managerUserId = String(data.manager_user_id);
  return {
    connected: true,
    revoked: false,
    workspaceId: String(data.workspace_id),
    managerUserId,
    pageId: (data.page_id as string | null) ?? null,
    pageName: (data.page_name as string | null) ?? null,
    igAccountId: (data.ig_account_id as string | null) ?? null,
    igUsername: (data.ig_username as string | null) ?? null,
    pageToken: decryptSensitiveValue(String(data.page_token_encrypted), tokenContext(managerUserId, String(data.workspace_id))),
  };
}

export async function saveMetaConnection(
  db: SupabaseClient,
  args: { workspaceId: string; managerUserId: string; metaUserId: string; page: MetaManagedPage },
): Promise<void> {
  const { error } = await db.from("listing_channel_connections").upsert(
    {
      workspace_id: args.workspaceId,
      manager_user_id: args.managerUserId,
      provider: "meta",
      provider_subject: args.metaUserId,
      page_id: args.page.id,
      page_name: args.page.name,
      ig_account_id: args.page.igAccountId,
      ig_username: args.page.igUsername,
      page_token_encrypted: encryptSensitiveValue(args.page.accessToken, tokenContext(args.managerUserId, args.workspaceId)),
      project_ref: supabaseProjectRef(),
      revoked: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,provider" },
  );
  if (error) throw new Error(error.message);
}

/** A token Meta rejected: stop trying until the manager reconnects. */
export async function markMetaConnectionRevoked(db: SupabaseClient, workspaceId: string): Promise<void> {
  await db
    .from("listing_channel_connections")
    .update({ revoked: true, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("provider", "meta");
}

export async function deleteMetaConnection(db: SupabaseClient, workspaceId: string): Promise<void> {
  await db.from("listing_channel_connections").delete().eq("workspace_id", workspaceId).eq("provider", "meta");
}

/**
 * Meta data-deletion: remove every stored token for this Meta user and the rows those connections
 * posted (Facebook Page + Instagram). Returns how many connections were removed.
 */
export async function deleteMetaDataForProviderUser(db: SupabaseClient, metaUserId: string): Promise<number> {
  const { data, error } = await db
    .from("listing_channel_connections")
    .select("workspace_id, manager_user_id")
    .eq("provider", "meta")
    .eq("provider_subject", metaUserId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { workspace_id: string; manager_user_id: string }[];
  for (const row of rows) {
    await db
      .from("listing_channel_posts")
      .delete()
      .eq("workspace_id", row.workspace_id)
      .eq("manager_user_id", row.manager_user_id)
      .in("channel", ["facebook_page", "instagram"]);
    await deleteMetaConnection(db, row.workspace_id);
  }
  return rows.length;
}
