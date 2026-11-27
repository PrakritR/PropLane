import "server-only";

import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import {
  asStringArray,
  INVITE_PERMISSION_COLUMNS,
  readHouseScopeFromRow,
  readPropertyPermissionsFromRow,
} from "@/lib/account-link-invite-row";
import { hasCoManagerPermissionLevelForProperty } from "@/lib/co-manager-permissions";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { managedHouseIdsOrThrow, managedHouseWorkspacesOrThrow } from "@/lib/google-calendar/tour-calendar-owner.server";
import { serviceSeatVerdict } from "@/lib/service/service-mode";
import { platformServiceOwnerId, readStoredOwner } from "@/lib/service/service-owner.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { listTourHostUserIdsByHouseOrThrow } from "@/lib/tour-host-enumeration.server";

export const PLANNED_EVENTS_RECORD_ID = "axis_admin_planned_events_v1";
export const PARTNER_INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;
export type ScheduleRecordUser = {
  id: string;
  role: string;
  roles?: string[];
  /** Houses of the PropLane-managed workspace this viewer is service staff of (server-derived from membership). */
  serviceScope?: { propertyIds: string[] } | null;
};
type ScheduleRecord = Record<string, unknown>;
type ScheduleItem = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): ScheduleItem | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ScheduleItem
    : null;
}

function hasRole(user: ScheduleRecordUser, role: string): boolean {
  return user.role === role || (Array.isArray(user.roles) && user.roles.includes(role));
}

function recordPayload(record: ScheduleRecord): ScheduleItem[] {
  const rowData = object(record.row_data);
  return Array.isArray(rowData?.payload)
    ? rowData.payload.filter((item): item is ScheduleItem => Boolean(object(item)))
    : [];
}

function itemPropertyId(item: ScheduleItem): string {
  return text(item.propertyId ?? item.property_id);
}

function itemManagerUserId(item: ScheduleItem): string {
  return text(item.managerUserId ?? item.manager_user_id);
}

export function isStandaloneInquiry(record: ScheduleRecord): boolean {
  const type = text(record.record_type).toLowerCase();
  if (type.includes("inquir")) return true;
  const rowData = object(record.row_data);
  return text(rowData?.kind).toLowerCase() === "tour" && Boolean(itemPropertyId(rowData ?? {}));
}

function standaloneInquiryItem(record: ScheduleRecord): ScheduleItem | null {
  const rowData = object(record.row_data);
  return object(rowData?.payload) ?? rowData;
}

function busyProjection(item: ScheduleItem): ScheduleItem {
  const allowed = [
    "id",
    "kind",
    "status",
    "propertyId",
    "property_id",
    "managerUserId",
    "manager_user_id",
    "start",
    "end",
    "startsAt",
    "endsAt",
    "starts_at",
    "ends_at",
    "proposedStart",
    "proposedEnd",
    "slotKey",
    "slotBlocked",
    "assignee",
    // Safe lifecycle/roster signals: required for a viewer to distinguish a
    // canceled busy block and for the claim route's trusted host check.
    "canceledAt",
    "eligibleHostUserIds",
    "requestedWindows",
  ];
  const projected = Object.fromEntries(allowed.flatMap((key) => key in item ? [[key, item[key]]] : []));
  if (Array.isArray(item.requestedWindows)) {
    projected.requestedWindows = item.requestedWindows
      .map((window) => object(window))
      .filter((window): window is ScheduleItem => Boolean(window))
      .map((window) => Object.fromEntries(
        ["start", "end", "slotKey"].flatMap((key) => key in window ? [[key, window[key]]] : []),
      ));
  }
  return projected;
}

async function propertyOwners(db: Db, propertyIds: Set<string>, throwOnError = false): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (propertyIds.size === 0) return owners;
  try {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id")
      .in("id", [...propertyIds]);
    if (error) {
      if (throwOnError) throw error;
      return owners;
    }
    for (const row of data ?? []) {
      const id = text((row as ScheduleRecord).id);
      const owner = text((row as ScheduleRecord).manager_user_id);
      if (id && owner) owners.set(id, owner);
    }
  } catch (error) {
    // Missing ownership data must narrow shared-record access, never widen it; a strict read says so instead.
    if (throwOnError) throw error;
  }
  return owners;
}

/**
 * Everyone who may host a tour on each house, derived server-side and never from a row: the owner, the owner's
 * co-managers who may host there (`listPropertyTourHostUserIds`), and the platform operator of a PropLane-managed
 * house. `createTourInquiry` stamps a standalone request with its host, so these are the trusted writers of one.
 * A fixed number of reads whatever the house count. `managedHouses` are already known to be managed (a staff scope);
 * the rest are checked. Strict: any unreadable read throws. Otherwise it narrows (owner only, no operator).
 */
export async function tourHostIdsByHouse(
  db: Db,
  ownersByHouse: ReadonlyMap<string, string>,
  options: { throwOnError?: boolean; managedHouses?: ReadonlySet<string> } = {},
): Promise<Map<string, Set<string>>> {
  if (ownersByHouse.size === 0) return new Map();
  const strict = options.throwOnError === true;
  const known = options.managedHouses ?? new Set<string>();
  const unchecked = new Map([...ownersByHouse].filter(([house]) => !known.has(house)));
  const [roster, checked] = await Promise.all([
    listTourHostUserIdsByHouseOrThrow(db, ownersByHouse).catch((error: unknown) => {
      if (strict) throw error;
      return new Map([...ownersByHouse].map(([house, owner]) => [house, new Set(owner ? [owner] : [])]));
    }),
    unchecked.size > 0
      ? managedHouseIdsOrThrow(db, unchecked).catch((error: unknown) => {
          if (strict) throw error;
          return new Set<string>();
        })
      : Promise.resolve(new Set<string>()),
  ]);
  const anyManaged = [...ownersByHouse.keys()].some((house) => known.has(house) || checked.has(house));
  const operator = anyManaged ? (strict ? await readStoredOwner(db) : await platformServiceOwnerId(db)) : null;
  const hosts = new Map<string, Set<string>>();
  for (const [house, owner] of ownersByHouse) {
    const ids = new Set(roster.get(house) ?? (owner ? [owner] : []));
    if (operator && (known.has(house) || checked.has(house))) ids.add(operator);
    hosts.set(house, ids);
  }
  return hosts;
}

/**
 * Everyone trusted to plan an event on each house (house id -> owner id), derived server-side and never from an item:
 * the owner, every accepted seat the owner granted on that house with Calendar or Services at edit (an assignment or
 * a read grant is not a grant), and on a PropLane-managed house the operator and the service staff whose own seat
 * reaches that house. The planned-events write keeps an item naming a house only when its
 * writer is in this set, and the read shows it to the house's people only under the same answer. Strict: any
 * unreadable read throws. Otherwise it narrows to the owner.
 */
export async function plannedHouseWritersByHouse(
  db: Db,
  ownersByHouse: ReadonlyMap<string, string>,
  options: { throwOnError?: boolean } = {},
): Promise<Map<string, Set<string>>> {
  const writers = new Map([...ownersByHouse].map(([house, owner]) => [house, new Set(owner ? [owner] : [])]));
  if (ownersByHouse.size === 0) return writers;
  try {
    const owners = [...new Set([...ownersByHouse.values()].filter(Boolean))];
    const [links, managed] = await Promise.all([
      owners.length > 0
        ? db
            .from("account_link_invites")
            .select(`inviter_user_id, invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
            .eq("status", "accepted")
            .in("inviter_user_id", owners)
            .then(withoutOwnerLinks)
        : Promise.resolve({ data: [], error: null }),
      managedHouseWorkspacesOrThrow(db, ownersByHouse),
    ]);
    if (links.error) throw new Error("account_link_invites unreadable");
    for (const row of (links.data ?? []) as ScheduleRecord[]) {
      const invitee = text(row.invitee_user_id);
      const assigned = asStringArray(row.assigned_property_ids);
      if (!invitee) continue;
      const permissions = readPropertyPermissionsFromRow(row as Parameters<typeof readPropertyPermissionsFromRow>[0]);
      for (const [house, owner] of ownersByHouse) {
        if (owner !== text(row.inviter_user_id) || !assigned.includes(house)) continue;
        if (
          hasCoManagerPermissionLevelForProperty(permissions, house, "calendar", "edit") ||
          hasCoManagerPermissionLevelForProperty(permissions, house, "services", "edit")
        ) writers.get(house)?.add(invitee);
      }
    }
    if (managed.size === 0) return writers;
    const workspaceIds = [...new Set(managed.values())];
    const [operator, seats, workspaces] = await Promise.all([
      readStoredOwner(db),
      db
        .from("account_link_invites")
        .select("workspace_id, inviter_user_id, invitee_user_id, team_role, is_service_seat, house_scope, assigned_property_ids")
        .eq("status", "accepted")
        .in("workspace_id", workspaceIds)
        .then(withoutOwnerLinks),
      db.from("portal_workspaces").select("id, owner_user_id").in("id", workspaceIds),
    ]);
    if (seats.error) throw new Error("account_link_invites unreadable");
    if (workspaces.error) throw new Error("portal_workspaces unreadable");
    const workspaceOwner = new Map(
      ((workspaces.data ?? []) as ScheduleRecord[]).map((row) => [text(row.id), text(row.owner_user_id)] as const),
    );
    const staffSeats: Array<{ seat: ScheduleRecord; workspaceId: string; invitee: string }> = [];
    const adminCandidates = new Set<string>();
    for (const seat of (seats.data ?? []) as ScheduleRecord[]) {
      const workspaceId = text(seat.workspace_id);
      const invitee = text(seat.invitee_user_id);
      if (!workspaceId || !invitee) continue;
      const verdict = serviceSeatVerdict(
        {
          workspaceId,
          inviterUserId: text(seat.inviter_user_id),
          teamRole: typeof seat.team_role === "string" ? seat.team_role : null,
          isServiceSeat: seat.is_service_seat === true,
        },
        { ownerUserId: workspaceOwner.get(workspaceId) ?? "" },
        operator,
      );
      if (verdict === "no") continue;
      if (verdict === "platform_person_only") adminCandidates.add(invitee);
      staffSeats.push({ seat, workspaceId, invitee: verdict === "staff" ? invitee : "" });
    }
    const admins = new Set<string>();
    if (adminCandidates.size > 0) {
      const { data, error } = await db.from("profile_roles").select("user_id").eq("role", "admin").in("user_id", [...adminCandidates]);
      if (error) throw new Error("profile_roles unreadable");
      for (const row of (data ?? []) as ScheduleRecord[]) admins.add(text(row.user_id));
    }
    for (const [house, workspaceId] of managed) {
      const ids = writers.get(house);
      if (!ids) continue;
      if (operator) ids.add(operator);
      for (const { seat, workspaceId: seatWorkspace, invitee } of staffSeats) {
        const holder = invitee || (admins.has(text(seat.invitee_user_id)) ? text(seat.invitee_user_id) : "");
        if (!holder || seatWorkspace !== workspaceId) continue;
        const reaches =
          readHouseScopeFromRow(seat as Parameters<typeof readHouseScopeFromRow>[0]) === "all" ||
          asStringArray(seat.assigned_property_ids).includes(house);
        if (reaches) ids.add(holder);
      }
    }
    return writers;
  } catch (error) {
    if (options.throwOnError === true) throw error;
    return new Map([...ownersByHouse].map(([house, owner]) => [house, new Set(owner ? [owner] : [])]));
  }
}

/**
 * Projects service-role schedule rows before they cross the HTTP boundary.
 * Shared singletons are JSON containers, so their table row cannot be the
 * authorization unit. Property ownership and an explicit calendar-read grant
 * decide each contained item. Co-managers receive free/busy fields only.
 */
export async function projectScheduleRecordsForViewer(
  db: Db,
  user: ScheduleRecordUser,
  records: ScheduleRecord[],
  options: {
    throwOnError?: boolean;
    /**
     * The viewer's ACTIVE workspace houses (`activeWorkspacePropertyScope`). `null`/absent = not narrowing. The shared
     * singleton containers hold every workspace's items under one row, so an item naming a house outside this set is
     * dropped here, whatever the viewer's grants or seats would otherwise show.
     */
    workspaceScope?: readonly string[] | null;
  } = {},
): Promise<ScheduleRecord[]> {
  const admin = hasRole(user, "admin");
  const workspaceHouses = options.workspaceScope ? new Set(options.workspaceScope) : null;
  const outsideWorkspace = (item: ScheduleItem): boolean => {
    if (!workspaceHouses) return false;
    const house = itemPropertyId(item);
    return Boolean(house) && !workspaceHouses.has(house);
  };
  const manager = hasRole(user, "manager");
  const propertyIds = new Set<string>();
  for (const record of records) {
    for (const item of recordPayload(record)) {
      const propertyId = itemPropertyId(item);
      if (propertyId) propertyIds.add(propertyId);
    }
    if (isStandaloneInquiry(record)) {
      const propertyId = itemPropertyId(standaloneInquiryItem(record) ?? {});
      if (propertyId) propertyIds.add(propertyId);
    }
  }

  const [owners, linked, applicationHosts] = await Promise.all([
    propertyOwners(db, propertyIds, options.throwOnError === true),
    manager && !admin
      ? linkedOwnerScopeForModule(db, user.id, "calendar", "read", options)
      : Promise.resolve(null),
    manager && !admin
      ? linkedOwnerScopeForModule(db, user.id, "applications", "edit", options)
      : Promise.resolve(null),
  ]);

  const hostCheckHouses = new Map<string, string>();
  if (!admin && manager) {
    for (const record of records) {
      if (!isStandaloneInquiry(record)) continue;
      const writer = text(record.manager_user_id);
      const propertyId = itemPropertyId(standaloneInquiryItem(record) ?? {});
      const owner = propertyId ? owners.get(propertyId) ?? "" : "";
      if (writer && owner && writer !== owner) hostCheckHouses.set(propertyId, owner);
    }
  }
  // A shared planned-events item carries no row column, so its payload `managerUserId` (server-pinned on write)
  // is the writer; an item naming a house is trusted only under the same writer set the write enforces.
  const plannedCheckHouses = new Map<string, string>();
  if (!admin && manager) {
    for (const record of records) {
      if (text(record.id) !== PLANNED_EVENTS_RECORD_ID) continue;
      for (const item of recordPayload(record)) {
        const propertyId = itemPropertyId(item);
        const owner = propertyId ? owners.get(propertyId) ?? "" : "";
        if (propertyId && owner && itemManagerUserId(item) && itemManagerUserId(item) !== owner) {
          plannedCheckHouses.set(propertyId, owner);
        }
      }
    }
  }
  const [hostsByHouse, plannedWritersByHouse] = await Promise.all([
    tourHostIdsByHouse(db, hostCheckHouses, {
      throwOnError: options.throwOnError === true,
      managedHouses: new Set(user.serviceScope?.propertyIds ?? []),
    }),
    plannedHouseWritersByHouse(db, plannedCheckHouses, { throwOnError: options.throwOnError === true }),
  ]);

  const staffHouses = new Set(user.serviceScope?.propertyIds ?? []);
  const maySeeItem = (
    item: ScheduleItem,
    pendingInquiry = false,
    provenance: { rowManagerUserId: string; columnPropertyId: string; planned?: boolean } | null = null,
  ): "full" | "busy" | null => {
    if (admin) return "full";
    if (!manager) return null;
    // A standalone row's payload `managerUserId` is a body claim any manager can plant; only the row's
    // server-pinned `manager_user_id` column says who wrote it. Shared-container items have no such column.
    if (provenance) {
      if (provenance.rowManagerUserId === user.id) return "full";
    } else if (itemManagerUserId(item) === user.id) return "full";
    const propertyId = itemPropertyId(item);
    // A standalone row is a free-form generic upsert any manager can write, so the payload's house is a claim,
    // not a fact. Show it through the staff / co-manager rules only when the row was written by that house's
    // owner, by an eligible tour host of that house (`tourHostIdsByHouse`), or by the server (null), and its
    // column house agrees with the payload. Otherwise drop, never busy.
    const trustedProvenance = (): boolean => {
      if (!provenance) return true;
      if (provenance.columnPropertyId && provenance.columnPropertyId !== propertyId) return false;
      const writer = provenance.rowManagerUserId;
      if (!writer) return true;
      const houseOwner = propertyId ? owners.get(propertyId) ?? "" : "";
      const trusted = provenance.planned ? plannedWritersByHouse : hostsByHouse;
      return writer === houseOwner || Boolean(propertyId && trusted.get(propertyId)?.has(writer));
    };
    // Service staff run the managed workspace they hold a seat in: a tour request filed on one of its houses is
    // theirs to read and answer, whoever the request was filed under. Derived from membership, never the request.
    const owner = propertyId ? owners.get(propertyId) ?? "" : "";
    if (owner && owner === user.id) return "full";
    if (propertyId && staffHouses.has(propertyId)) return trustedProvenance() ? "full" : null;
    if (!propertyId || !owner) return null;
    if (!trustedProvenance()) return null;
    // A pending request is hostless: an eligible host holding Applications at edit on that house is the
    // person who approves it (`confirmTourInquiry` re-checks the same roster), and that grant already shows
    // them every applicant's contact details on the house — so they read the whole request (captain, round 6
    // plan, Nov 16: the full row reaches the host, never a stripped busy copy). The roster is server-stamped,
    // never a body id; a calendar-only peer still gets the free/busy copy below.
    if (
      pendingInquiry &&
      applicationHosts?.propertyIdsByOwner.get(owner)?.has(propertyId) &&
      Array.isArray(item.eligibleHostUserIds) &&
      item.eligibleHostUserIds.some((id) => text(id) === user.id)
    ) return "full";
    if (linked?.propertyIdsByOwner.get(owner)?.has(propertyId)) return "busy";
    return null;
  };

  const projected: ScheduleRecord[] = [];
  for (const record of records) {
    const id = text(record.id);
    const sharedPlanned = id === PLANNED_EVENTS_RECORD_ID;
    const sharedInquiries = id === PARTNER_INQUIRIES_RECORD_ID;
    if (sharedPlanned || sharedInquiries) {
      if (!admin && !manager) continue;
      const rowData = object(record.row_data) ?? {};
      const payload = recordPayload(record).flatMap((item) => {
        if (outsideWorkspace(item)) return [];
        const access = maySeeItem(
          item,
          sharedInquiries && text(item.status).toLowerCase() === "pending",
          sharedPlanned ? { rowManagerUserId: itemManagerUserId(item), columnPropertyId: "", planned: true } : null,
        );
        return access === "full" ? [item] : access === "busy" ? [busyProjection(item)] : [];
      });
      // Both shared containers are authoritative observed snapshots. Keeping
      // an empty inquiry singleton lets the client clear a previously visible
      // inquiry after acceptance, deletion, or grant removal.
      projected.push({
        ...record,
        row_data: {
          id: text(rowData.id) || id,
          recordType: text(rowData.recordType) || text(record.record_type) || id,
          payload,
        },
      });
      continue;
    }

    if (isStandaloneInquiry(record)) {
      const rowData = object(record.row_data);
      const item = standaloneInquiryItem(record);
      if (item && outsideWorkspace(item)) continue;
      const access = item
        ? maySeeItem(item, text(item.status).toLowerCase() === "pending", {
            rowManagerUserId: text(record.manager_user_id),
            columnPropertyId: text(record.property_id),
          })
        : null;
      if (!access || !item) continue;
      const visibleItem = access === "full" ? item : busyProjection(item);
      projected.push({
        ...record,
        row_data: object(rowData?.payload)
          ? {
              id: text(rowData?.id) || text(record.id),
              recordType: text(rowData?.recordType) || text(record.record_type),
              payload: visibleItem,
            }
          : visibleItem,
      });
      continue;
    }

    if (admin || text(record.manager_user_id) === user.id) projected.push(record);
  }
  return projected;
}
