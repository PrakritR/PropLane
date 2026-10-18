import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntry, updateEntry } from "./store.server";
import { loadOwnedProperty } from "./scope.server";
import type { ReplyTopic } from "./topics";
import type { KnowledgeAudience, KnowledgeEntry } from "./types";

export type ApprovalScope = "house" | "team";

export type ApprovalResult =
  | { ok: true; entry: KnowledgeEntry }
  | { ok: false; reason: "not_found" | "not_suggested" | "no_house" | "failed" };

/**
 * Approve a suggested entry. The entry is re-read by (workspace, id) so an id from a request or a
 * model can only ever reach this workspace's own rows. "team" makes it apply to every house in
 * the workspace; "house" keeps (or sets) the entry's own house, and refuses an entry that has none.
 */
export async function approveSuggestedEntry(
  db: SupabaseClient,
  args: {
    workspaceId: string;
    ownerUserId: string;
    entryId: string;
    actorUserId: string;
    scope: ApprovalScope;
    audience?: KnowledgeAudience;
    edits?: { question?: string; answer?: string; topic?: ReplyTopic };
    /** A house the caller already proved belongs to the workspace, used when the entry has none. */
    houseId?: string | null;
  },
): Promise<ApprovalResult> {
  const entry = await getEntry(db, args.workspaceId, args.entryId);
  if (!entry) return { ok: false, reason: "not_found" };
  if (entry.status !== "suggested") return { ok: false, reason: "not_suggested" };

  let propertyId: string | null;
  if (args.scope === "team") {
    propertyId = null;
  } else {
    propertyId = entry.propertyId ?? args.houseId ?? null;
    if (!propertyId) return { ok: false, reason: "no_house" };
    const owned = await loadOwnedProperty(db, args.ownerUserId, propertyId);
    if (!owned || owned.workspaceId !== args.workspaceId) return { ok: false, reason: "no_house" };
  }
  const updated = await updateEntry(db, {
    workspaceId: args.workspaceId,
    entryId: entry.id,
    decidedBy: args.actorUserId,
    patch: {
      ...args.edits,
      propertyId,
      status: "approved",
      ...(args.audience ? { audience: args.audience } : {}),
    },
  });
  return updated ? { ok: true, entry: updated } : { ok: false, reason: "failed" };
}

export async function dismissSuggestedEntry(
  db: SupabaseClient,
  args: { workspaceId: string; entryId: string; actorUserId: string },
): Promise<boolean> {
  const entry = await getEntry(db, args.workspaceId, args.entryId);
  if (!entry || entry.status !== "suggested") return false;
  const updated = await updateEntry(db, {
    workspaceId: args.workspaceId,
    entryId: entry.id,
    decidedBy: args.actorUserId,
    patch: { status: "rejected" },
  });
  return Boolean(updated);
}
