/**
 * Fallback persistence for paid-account links when Supabase invites are unavailable (offline demo).
 * Primary flow: `/api/pro/account-links` + `account_link_invites` table.
 */

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { PRO_RELATIONSHIPS_EVENT, serverSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import type { CoManagerPermissions, PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import type { WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import {
  coManagerPermissionsFromLegacy,
  flatCoManagerPermissionsFromProperty,
  normalizePropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import type { AccountLinkInviteDto } from "@/lib/account-links";

export const AXIS_ID_LABEL = "PropLane ID";

/** @deprecated Owner tab removed — all links are co-manager (manager) links. */
export type ProRelationshipPerspective = "manager_tab";

export type ProRelationshipRecord = {
  id: string;
  linkedAxisId: string;
  linkedDisplayName?: string;
  /** Auth user id for the linked co-manager (when known). */
  linkedUserId?: string;
  /** Whether this workspace invited (outgoing) or was invited (incoming). */
  linkDirection?: "outgoing" | "incoming";
  perspective: ProRelationshipPerspective;
  /** Amount of managed revenue this manager receives on the linked properties (0–100). */
  payoutPercentForManager: number;
  assignedPropertyIds: string[];
  /** Permissions granted by the primary manager to this co-manager (merged flat). */
  coManagerPermissions?: CoManagerPermissions;
  /** Per-property permission grants. */
  propertyCoManagerPermissions?: PropertyCoManagerPermissions;
  /** Workspace grants — Add properties / Invite teammates. Empty = none. */
  workspacePermissions?: WorkspaceCoManagerGrant;
  /** @deprecated Use coManagerPermissions.editListings */
  canEditListing?: boolean;
  createdAt: string;
};

const memoryByUser = new Map<string, ProRelationshipRecord[]>();
const RELATIONSHIPS_SYNC_TTL_MS = 15_000;
const relationshipsLastSyncedAt = new Map<string, number>();
const relationshipsSyncPromises = new Map<string, Promise<ProRelationshipRecord[]>>();
const relationshipsRefreshers = new Map<string, CoalescedRefresher<ProRelationshipRecord[]>>();

/** Merge server/local relationship rows. Exported for unit tests. */
export function mergeRelationshipRows(
  previous: ProRelationshipRecord[],
  incoming: ProRelationshipRecord[],
): ProRelationshipRecord[] {
  const merged = incoming.map((row) => {
    const prev = previous.find((item) => item.id === row.id);
    if (!prev) return row;
    const prevIds = prev.assignedPropertyIds;
    const nextIds = row.assignedPropertyIds;
    // Only preserve previous ids when the incoming payload omitted the list
    // entirely (empty). A shorter non-empty list must win — otherwise removing
    // a property from a co-manager link never sticks on the client.
    const keepPrevIds = prevIds.length > 0 && nextIds.length === 0;
    const keepPrevPerms =
      Object.keys(prev.propertyCoManagerPermissions ?? {}).length > 0 &&
      Object.keys(row.propertyCoManagerPermissions ?? {}).length === 0;
    if (!keepPrevIds && !keepPrevPerms && !prev.linkDirection && row.linkDirection) return row;
    if (!keepPrevIds && !keepPrevPerms && prev.linkDirection) return row;
    return {
      ...row,
      assignedPropertyIds: keepPrevIds ? prevIds : nextIds,
      propertyCoManagerPermissions: keepPrevPerms
        ? prev.propertyCoManagerPermissions
        : row.propertyCoManagerPermissions ?? prev.propertyCoManagerPermissions,
      coManagerPermissions: row.coManagerPermissions ?? prev.coManagerPermissions,
      linkDirection: row.linkDirection ?? prev.linkDirection,
      linkedUserId: row.linkedUserId ?? prev.linkedUserId,
      linkedDisplayName: row.linkedDisplayName ?? prev.linkedDisplayName,
    };
  });
  for (const prev of previous) {
    if (!merged.some((row) => row.id === prev.id)) merged.push(prev);
  }
  return merged;
}

function relationshipsChanged(a: ProRelationshipRecord[], b: ProRelationshipRecord[]): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function normalizeProRelationshipRecord(raw: unknown): ProRelationshipRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id;
  const linkedAxisId = r.linkedAxisId;
  if (typeof id !== "string" || typeof linkedAxisId !== "string") return null;
  // Legacy owner/manager perspectives were collapsed; all links are co-manager links.
  const perspective: ProRelationshipPerspective = "manager_tab";
  const payout = Number(r.payoutPercentForManager);
  const assigned = Array.isArray(r.assignedPropertyIds)
    ? (r.assignedPropertyIds as unknown[]).filter((x) => typeof x === "string")
    : [];
  const assignedPropertyIds = assigned as string[];
  const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
    r.propertyCoManagerPermissions ?? r.coManagerPermissions,
    assignedPropertyIds,
  );
  const coManagerPermissions = coManagerPermissionsFromLegacy({
    canEditListing: r.canEditListing === true,
    coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
  });
  const linkedUserId = r.linkedUserId;
  const linkDirection = r.linkDirection;
  return {
    id,
    linkedAxisId,
    linkedDisplayName: typeof r.linkedDisplayName === "string" ? r.linkedDisplayName : undefined,
    linkedUserId: typeof linkedUserId === "string" ? linkedUserId : undefined,
    linkDirection:
      linkDirection === "outgoing" || linkDirection === "incoming" ? linkDirection : undefined,
    perspective,
    payoutPercentForManager: Number.isFinite(payout) ? payout : 15,
    assignedPropertyIds,
    coManagerPermissions,
    propertyCoManagerPermissions,
    canEditListing: r.canEditListing === true ? true : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
  };
}

export type RevokedInviteRelationshipScope = {
  managerUserId: string;
  linkedAxisId: string;
};

/** Workspace-scoped relationship rows to remove when a single co-manager link is revoked. */
export function scopedRelationshipDeletesForRevokedInvite(invite: {
  inviter_user_id?: string | null;
  invitee_user_id?: string | null;
  inviter_axis_id?: string | null;
  invitee_axis_id?: string | null;
}): RevokedInviteRelationshipScope[] {
  const inviterId = String(invite.inviter_user_id ?? "").trim();
  const inviteeId = String(invite.invitee_user_id ?? "").trim();
  const inviterAxis = String(invite.inviter_axis_id ?? "").trim();
  const inviteeAxis = String(invite.invitee_axis_id ?? "").trim();
  const scopes: RevokedInviteRelationshipScope[] = [];
  if (inviterId && inviteeAxis) scopes.push({ managerUserId: inviterId, linkedAxisId: inviteeAxis });
  if (inviteeId && inviterAxis) scopes.push({ managerUserId: inviteeId, linkedAxisId: inviterAxis });
  return scopes;
}

function migrateRow(r: Record<string, unknown>): ProRelationshipRecord | null {
  return normalizeProRelationshipRecord(r);
}

export function proRelationshipRowsFromInvites(invites: AccountLinkInviteDto[]): ProRelationshipRecord[] {
  return invites
    .filter((inv) => inv.status === "accepted")
    .map((inv) => {
      const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
        inv.propertyCoManagerPermissions ?? inv.coManagerPermissions,
        inv.assignedPropertyIds,
      );
      const perms = coManagerPermissionsFromLegacy({
        coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
      });
      return {
        id: inv.id,
        linkedAxisId: inv.linkedAxisId,
        linkedDisplayName: inv.linkedDisplayName ?? undefined,
        linkedUserId: inv.linkedUserId,
        linkDirection: inv.direction,
        perspective: "manager_tab" as const,
        payoutPercentForManager: inv.payoutPercentForManager,
        assignedPropertyIds: inv.assignedPropertyIds,
        coManagerPermissions: perms,
        propertyCoManagerPermissions,
        canEditListing: perms.properties ? true : undefined,
        createdAt: inv.createdAt,
      };
    });
}

export function readProRelationships(userId: string): ProRelationshipRecord[] {
  if (typeof window === "undefined" || !userId.trim()) return [];
  if (!memoryByUser.has(userId)) void syncProRelationshipsFromServer(userId).catch(() => undefined);
  return memoryByUser.get(userId) ?? [];
}

export function writeProRelationships(userId: string, rows: ProRelationshipRecord[]): void {
  if (typeof window === "undefined") return;
  // Skip the dispatch + network write when nothing actually changed. The
  // "axis-pro-relationships" event re-enters render effects that can call back
  // into writeProRelationships, so an unconditional dispatch here turns any
  // stray re-render into an event/refetch loop. The no-op guard makes that
  // impossible regardless of caller render behavior.
  const existing = memoryByUser.get(userId);
  if (existing && !relationshipsChanged(existing, rows)) return;
  memoryByUser.set(userId, rows);
  window.dispatchEvent(new Event("axis-pro-relationships"));
  void fetch("/api/portal-pro-relationships", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      action: "replace",
      rows: rows.map((row) => ({ ...row, managerUserId: userId })),
    }),
  }).catch(() => undefined);
}

export async function syncProRelationshipsFromServer(
  userId: string,
  opts?: { force?: boolean },
): Promise<ProRelationshipRecord[]> {
  if (typeof window === "undefined" || !userId.trim()) return [];
  if (isDemoModeActive()) return memoryByUser.get(userId) ?? [];
  const force = opts?.force === true;
  const inFlight = relationshipsSyncPromises.get(userId);
  if (!force && inFlight) return inFlight;

  const lastSyncedAt = relationshipsLastSyncedAt.get(userId) ?? 0;
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < RELATIONSHIPS_SYNC_TTL_MS) {
    return memoryByUser.get(userId) ?? [];
  }

  // Forced callers bypass the TTL by design, so the several panels that force a
  // refresh on mount each issued their own fetch (measured: 6 on one
  // `/portal/properties` load). Collapse those into at most two without ever
  // serving a forced caller a fetch that began before it asked.
  let refresher = relationshipsRefreshers.get(userId);
  if (!refresher) {
    refresher = createCoalescedRefresher(() => runRelationshipsSync(userId));
    relationshipsRefreshers.set(userId, refresher);
  }
  return refresher.run(force);
}

async function runRelationshipsSync(userId: string): Promise<ProRelationshipRecord[]> {
  const promise = (async () => {
    try {
      const res = await fetch("/api/portal-pro-relationships", { credentials: "include", cache: "no-store" });
      if (!res.ok) return memoryByUser.get(userId) ?? [];
      const body = (await res.json()) as { rows?: unknown[] };
      const rows = (body.rows ?? [])
        .map((x) => migrateRow(x as Record<string, unknown>))
        .filter(Boolean) as ProRelationshipRecord[];
      const previous = memoryByUser.get(userId) ?? [];
      const merged = mergeRelationshipRows(previous, rows);
      memoryByUser.set(userId, merged);
      relationshipsLastSyncedAt.set(userId, Date.now());
      if (relationshipsChanged(previous, merged)) {
        // Tagged as sync-originated: `memoryByUser` above already holds the
        // fresh rows, so listeners must NOT force another server round trip.
        window.dispatchEvent(serverSyncOriginatedEvent(PRO_RELATIONSHIPS_EVENT));
      }
      return merged;
    } catch {
      return memoryByUser.get(userId) ?? [];
    }
  })();

  relationshipsSyncPromises.set(userId, promise);
  try {
    return await promise;
  } finally {
    relationshipsSyncPromises.delete(userId);
  }
}

export function generateRelationshipId(): string {
  return `rel-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
