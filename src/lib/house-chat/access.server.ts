import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunicationScope } from "@/lib/communication/conversation-visibility.server";
import type { LeaseScopeRecord } from "@/lib/auth/manager-lease-scope";
import { pacificDayKey } from "@/lib/house-groups/time";
import type { OccupancyStayLike } from "@/lib/house-groups/stay-members";
import { houseThreadAliasToken, parseHouseThreadId, type ParsedHouseThreadId } from "@/lib/house-thread-id";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { houseResidentsFromStays, type HouseResident } from "./model";

/**
 * Who may read or post in a house chat, re-derived from the thread id on EVERY read and write. The stored
 * roster is never the authority:
 *
 * - a RESIDENT is a member while the Bookings occupancy snapshot shows a current long-term stay of theirs
 *   in that house (their login email on the lease). A moved-out resident, a short-stay guest and a
 *   stranger are refused the instant the stay ends, not at the next sweep;
 * - the TEAM is the workspace's owner, or an accepted member of THAT workspace who also holds
 *   Communication on THAT house (a teammate without the house grant is not in the chat; a Viewer reads
 *   but does not post). In a PropLane-managed workspace the staff are those same memberships.
 */

type Db = SupabaseClient;

export type HouseAccess =
  | { ok: true; kind: "team"; parsed: ParsedHouseThreadId; canPost: boolean }
  | { ok: true; kind: "resident"; parsed: ParsedHouseThreadId; canPost: true; resident: HouseResident }
  | { ok: false };

const DENIED: HouseAccess = { ok: false };

/** The house's label, when the house belongs to the workspace the thread names; `null` otherwise. */
export async function loadWorkspaceHouse(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; propertyId: string },
): Promise<{ label: string } | null> {
  try {
    const { data } = await db
      .from("manager_property_records")
      .select("id, workspace_id, manager_user_id, row_data")
      .eq("id", input.propertyId)
      .maybeSingle();
    const row = data as Record<string, unknown> | null;
    if (!row) return null;
    const ws = String(row.workspace_id ?? "").trim();
    const owner = String(row.manager_user_id ?? "").trim();
    // BOTH halves of the id are checked: a workspace that holds the house does not make the owner segment
    // true, so a forged id naming someone else's workspace (or someone else's owner) is refused here and
    // never reaches the grant check.
    if (owner !== input.ownerUserId) return null;
    if (ws && ws !== input.workspaceId) return null;
    return { label: propertyLabel(row.row_data) || "your house" };
  } catch {
    return null;
  }
}

/**
 * Every stay of these houses (the Bookings snapshot). A failed read throws.
 *
 * The long-term stays are built from the HOUSES' own leases, not from the owner's lease scope: a lease is
 * stamped to whoever filed it, so a teammate's lease would otherwise leave that resident out of their own
 * house chat. `propertyIds` is always a set the caller already proved belongs to the workspace, so reading
 * every lease on those houses is the house's own occupancy, never a widening.
 */
export async function loadOwnerStays(db: Db, ownerUserId: string, propertyIds: readonly string[]): Promise<OccupancyStayLike[]> {
  if (propertyIds.length === 0) return [];
  const { occupancySnapshotForManager } = await import("@/lib/occupancy/snapshot.server");
  const today = pacificDayKey(new Date());
  const snapshot = await occupancySnapshotForManager(db, ownerUserId, {
    propertyIds: [...propertyIds],
    from: today,
    to: today,
    days: [today],
    leaseRecords: await housesLeaseRecords(db, propertyIds),
  });
  return withLeaseResidentIdentity(db, snapshot.stays as unknown as SnapshotStay[]);
}

/** Every lease row filed under these houses, whoever filed it. A failed read throws (the caller refuses). */
async function housesLeaseRecords(db: Db, propertyIds: readonly string[]): Promise<LeaseScopeRecord[]> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  const out: LeaseScopeRecord[] = [];
  for (let at = 0; at < ids.length; at += 100) {
    const { data, error } = await db
      .from("portal_lease_pipeline_records")
      .select("id, row_data, updated_at, manager_user_id, property_id, resident_email")
      .in("property_id", ids.slice(at, at + 100))
      .limit(500);
    if (error) throw new Error("house leases unreadable");
    out.push(...((data ?? []) as LeaseScopeRecord[]));
  }
  return out;
}

type SnapshotStay = OccupancyStayLike & { name?: string; resident?: OccupancyStayLike["resident"] & { leaseId?: string } };

/**
 * A stay built from an executed lease carries the lease id but not the resident's email (only a matched
 * application adds it). The lease row's `resident_email` column is the identity the resident portal authorizes
 * on, so fill it in from there, in one batched read. A failed read leaves the stay as it was: a resident the
 * snapshot cannot name is not a member.
 */
async function withLeaseResidentIdentity(db: Db, stays: SnapshotStay[]): Promise<OccupancyStayLike[]> {
  const needy = stays.filter((stay) => stay.resident?.leaseId && !stay.resident.residentEmail);
  if (needy.length === 0) return stays;
  const ids = [...new Set(needy.map((stay) => stay.resident!.leaseId!))];
  const emailByLease = new Map<string, string>();
  try {
    for (let at = 0; at < ids.length; at += 100) {
      const { data } = await db
        .from("portal_lease_pipeline_records")
        .select("id, resident_email")
        .in("id", ids.slice(at, at + 100));
      for (const row of (data ?? []) as Array<{ id?: unknown; resident_email?: unknown }>) {
        const email = String(row.resident_email ?? "").trim().toLowerCase();
        if (row.id && email) emailByLease.set(String(row.id), email);
      }
    }
  } catch {
    return stays;
  }
  return stays.map((stay) => {
    const leaseId = stay.resident?.leaseId;
    const email = leaseId ? emailByLease.get(leaseId) : undefined;
    if (!stay.resident || !email) return stay;
    const named = stay.resident.residentName?.trim() || (stay.name && !/^resident$/i.test(stay.name.trim()) ? stay.name.trim() : undefined);
    return { ...stay, resident: { ...stay.resident, residentEmail: email, ...(named ? { residentName: named } : {}) } };
  });
}

const residentsCache = new Map<string, { at: number; residents: HouseResident[] }>();
const RESIDENT_READ_TTL_MS = 15_000;

/**
 * A house's current long-term residents today. `fresh` skips the 15 second per-process read cache: every
 * WRITE passes it. A failed read throws (the caller refuses; it never guesses a member).
 */
export async function currentHouseResidents(
  db: Db,
  input: { ownerUserId: string; propertyId: string; today?: string; fresh?: boolean },
): Promise<HouseResident[]> {
  const today = input.today ?? pacificDayKey(new Date());
  const key = `${input.ownerUserId}:${input.propertyId}:${today}`;
  const cacheable = !input.fresh && serverSnapshotCacheEnabled();
  if (cacheable) {
    const hit = residentsCache.get(key);
    if (hit && Date.now() - hit.at < RESIDENT_READ_TTL_MS) return hit.residents;
  }
  const stays = await loadOwnerStays(db, input.ownerUserId, [input.propertyId]);
  const residents = houseResidentsFromStays(stays, { propertyId: input.propertyId, today });
  if (cacheable) residentsCache.set(key, { at: Date.now(), residents });
  return residents;
}

/** Test seam. */
export function clearHouseResidentsCache(): void {
  residentsCache.clear();
}

/**
 * Pure: may this Communication scope read (or post in) the house chat? The owner always (in the active
 * workspace); anyone else needs an accepted membership of the thread's workspace AND the house grant at
 * the scope's level; posting also needs the membership to allow posting (not a Viewer).
 *
 * The active-workspace rule holds for a POST exactly as it does for a read: write access is never wider
 * than read access, so a chat this scope may not read is a chat it may not post into either.
 */
export function teamScopeAllowsHouseThread(
  scope: CommunicationScope,
  parsed: ParsedHouseThreadId,
): { allowed: boolean; canPost: boolean } {
  if (scope.closed) return { allowed: false, canPost: false };
  if (scope.activeWorkspaceId && scope.activeWorkspaceId !== parsed.workspaceId) {
    return { allowed: false, canPost: false };
  }
  if (scope.viewerId === parsed.ownerManagerUserId) return { allowed: true, canPost: true };
  const membership = scope.teamWorkspacesByOwner?.get(parsed.ownerManagerUserId)?.get(parsed.workspaceId);
  if (!membership) return { allowed: false, canPost: false };
  const granted = scope.grantedHousesByOwner.get(parsed.ownerManagerUserId);
  if (!granted?.has(parsed.propertyId)) return { allowed: false, canPost: false };
  return { allowed: true, canPost: membership.canPost };
}

/**
 * The one gate. `threadId` names the owner, workspace and house; `userId` / `email` are the session's.
 * `level: "edit"` is a post. Never reads the stored roster, and never trusts a body field.
 */
export async function assertHouseThreadAccess(
  db: Db,
  input: { threadId: string; userId: string; email: string; level: "read" | "edit"; fresh?: boolean; kinds?: ("team" | "resident")[] },
  deps: {
    resolveScope?: (level: "read" | "edit") => Promise<CommunicationScope>;
    residents?: (parsed: ParsedHouseThreadId) => Promise<HouseResident[]>;
    houseExists?: (parsed: ParsedHouseThreadId) => Promise<boolean>;
    resolveAlias?: (aliasId: string) => Promise<string | null>;
  } = {},
): Promise<HouseAccess> {
  // A resident holds the opaque alias; it is a lookup key only - the stored id it names is then authorized
  // from scratch, exactly like one typed in full.
  const storedId = houseThreadAliasToken(input.threadId)
    ? await (deps.resolveAlias ?? (async (aliasId: string) => (await import("./store.server")).resolveHouseThreadAlias(db, aliasId)))(
        input.threadId,
      ).catch(() => null)
    : input.threadId;
  const parsed = storedId ? parseHouseThreadId(storedId) : null;
  const userId = input.userId.trim();
  const email = input.email.trim().toLowerCase();
  if (!parsed || !userId) return DENIED;

  const houseExists =
    deps.houseExists ??
    (async (p: ParsedHouseThreadId) =>
      (await loadWorkspaceHouse(db, { workspaceId: p.workspaceId, ownerUserId: p.ownerManagerUserId, propertyId: p.propertyId })) !== null);
  if (!(await houseExists(parsed).catch(() => false))) return DENIED;

  const kinds = input.kinds ?? ["team", "resident"];

  // Team side.
  if (kinds.includes("team")) try {
    const scope = deps.resolveScope
      ? await deps.resolveScope(input.level)
      : await (await import("@/lib/communication/conversation-visibility.server")).resolveCommunicationScope(db, userId, input.level);
    const team = teamScopeAllowsHouseThread(scope, parsed);
    // A PropLane-managed workspace is view-only for its client: she reads the house chat with her
    // residents and posts nothing, the same lock the rest of her Property portal wears. Asked only on a
    // POST, and fail-closed (an unreadable lock answers "locked").
    const canPost =
      team.canPost && input.level === "edit"
        ? !(await (await import("@/lib/auth/managed-read-only.server")).isManagedReadOnly(db, userId, parsed.workspaceId))
        : team.canPost;
    if (team.allowed && (input.level === "read" || canPost)) {
      return { ok: true, kind: "team", parsed, canPost };
    }
  } catch {
    /* an unreadable grant shares nothing; fall through to the resident check */
  }

  // Resident side: a current long-term stay in THIS house under the session's own email.
  if (!kinds.includes("resident") || !email.includes("@")) return DENIED;
  try {
    const residents = deps.residents
      ? await deps.residents(parsed)
      : await currentHouseResidents(db, { ownerUserId: parsed.ownerManagerUserId, propertyId: parsed.propertyId, fresh: input.level === "edit" || input.fresh });
    const me = residents.find((resident) => resident.email === email);
    if (me) return { ok: true, kind: "resident", parsed, canPost: true, resident: me };
  } catch {
    /* a failed occupancy read refuses: no member is guessed */
  }
  return DENIED;
}
