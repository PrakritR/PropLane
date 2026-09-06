/** Server loader for resident house details — pure resolution lives in resident-move-in-resolve.ts (client-safe). */

import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  asObject,
  propertyFromRecord,
  resolveBestResidentRow,
  isRoommatePlacement,
  resolveResidentMoveInFromApplications,
  type ResidentMoveInHousemate,
  type ResidentMoveInResolved,
} from "@/lib/resident-move-in-resolve";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import { parseHousemateSharing, sharedHousemateDetails } from "@/lib/resident-housemate-sharing";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export { resolveResidentMoveInFromApplications, type ResidentMoveInResolved, type ResidentMoveInHousemate };

function formatPhoneDisplay(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

/**
 * The structured room id from a "propertyId::roomId" choice. Empty when the row
 * predates structured choices (a manually added resident), which is why the
 * roommate test below falls back to an exact room-name match only then.
 */
function canonicalRoomIdFromAppRow(row: DemoApplicantRow): string {
  const choice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  const sep = "::";
  const idx = choice.indexOf(sep);
  return idx >= 0 ? choice.slice(idx + sep.length).trim() : "";
}

/**
 * `roomNames` maps a listing room id to its display name. Without it a structured
 * `propertyId::roomId` choice with no piped label falls through as the raw id, and
 * a housemate who opted into sharing their room reads as "home::room-3".
 */
function roomLabelFromAppRow(row: DemoApplicantRow, roomNames?: Map<string, string>): string {
  const manual = row.manualResidentDetails?.roomNumber?.trim() || "";
  const assigned = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  if (manual) return manual;
  const named = roomNames?.get(canonicalRoomIdFromAppRow(row));
  if (named) return named;
  if (assigned) {
    const parts = assigned.split("|");
    const last = parts[parts.length - 1]?.trim() || assigned;
    return last.includes("::") ? last.slice(last.indexOf("::") + 2).trim() || last : last;
  }
  return "Room TBD";
}

/** Listing room id → display name, from either the live or the legacy submission shape. */
function listingRoomNames(record: { property_data?: unknown; row_data?: unknown } | null): Map<string, string> {
  const rooms =
    asObject(asObject(record?.property_data)?.listingSubmission)?.rooms ??
    asObject(asObject(record?.row_data)?.submission)?.rooms;
  const names = new Map<string, string>();
  if (!Array.isArray(rooms)) return names;
  for (const entry of rooms) {
    const room = asObject(entry);
    const id = String(room?.id ?? "").trim();
    const name = String(room?.name ?? "").trim();
    if (id && name) names.set(id, name);
  }
  return names;
}

function propertyIdFromAppRow(row: DemoApplicantRow): string {
  return (
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}

async function loadHousematesForProperty(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  selfEmail: string,
  propertyId: string,
  managerUserId: string | null | undefined,
  self: { roomId: string; roomLabel: string },
  roomNames: Map<string, string>,
): Promise<ResidentMoveInHousemate[]> {
  if (!propertyId || !managerUserId) return [];

  // Scoped to this property and paged: an unfiltered read stopped at Supabase's
  // 1,000-row ceiling, so a manager with a large application history silently lost
  // housemates. Every path `propertyIdFromAppRow` reads is queried, scalar columns
  // AND the `row_data` copies, because an older row can carry the placement only in
  // JSON while the scalar column is null or stale.
  const rows = new Map<string, { resident_email: string | null; row_data: unknown }>();
  const placementColumns = [
    "property_id",
    "assigned_property_id",
    "row_data->>assignedPropertyId",
    "row_data->>propertyId",
    "row_data->application->>propertyId",
  ] as const;
  for (const column of placementColumns) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("manager_application_records")
        .select("id, resident_email, row_data")
        .eq("manager_user_id", managerUserId)
        .eq(column, propertyId)
        .order("id")
        .range(offset, offset + 499);
      if (error) return [];
      for (const row of data ?? []) rows.set(String((row as { id: unknown }).id), row);
      if ((data ?? []).length < 500) break;
    }
  }

  const peers: Array<{ email: string; name: string; roomLabel: string; roomId: string }> = [];
  const seen = new Set<string>();
  for (const row of rows.values()) {
    const rowData = asObject(row.row_data) as unknown as DemoApplicantRow | null;
    if (!rowData || !isCurrentResidentApplicationRow(rowData) || rowData.withdrawnAt) continue;
    if (propertyIdFromAppRow(rowData) !== propertyId) continue;
    const email = String(row.resident_email ?? rowData.email ?? "")
      .trim()
      .toLowerCase();
    if (!email || email === selfEmail || seen.has(email)) continue;
    seen.add(email);
    peers.push({
      email,
      name: String(rowData.name ?? "").trim() || "Housemate",
      roomLabel: roomLabelFromAppRow(rowData, roomNames),
      roomId: canonicalRoomIdFromAppRow(rowData),
    });
  }

  if (peers.length === 0) return [];

  const { data: profiles } = await db
    .from("profiles")
    .select("id, email, phone, full_name")
    .in(
      "email",
      peers.map((p) => p.email),
    );

  const profileByEmail = new Map((profiles ?? []).map(profile => [String(profile.email ?? "").trim().toLowerCase(), profile]));
  const ids = (profiles ?? []).map(profile => String(profile.id ?? "")).filter(Boolean);
  const { data: preferenceRows, error: preferenceError } = ids.length
    ? await db.from("resident_housemate_sharing").select("user_id, preferences").in("user_id", ids)
    : { data: [], error: null };
  // A missing preference or unavailable preference lookup never grants disclosure.
  const preferencesById = new Map((preferenceError ? [] : preferenceRows ?? []).map(row => [String(row.user_id), parseHousemateSharing(row.preferences)]));
  return peers.map((peer, index) => {
    const profile = profileByEmail.get(peer.email);
    const sharing = parseHousemateSharing(preferencesById.get(String(profile?.id ?? "")));
    return {
      id: `housemate-${index}`,
      ...sharedHousemateDetails({ name: String(profile?.full_name ?? "").trim() || peer.name, email: peer.email,
        phone: formatPhoneDisplay(profile?.phone as string | null), roomLabel: peer.roomLabel }, sharing),
      isRoommate: sharing.shareRoom && isRoommatePlacement(self, { roomId: peer.roomId, roomLabel: peer.roomLabel }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function loadResidentMoveInForEmail(email: string, options?: { db?: ReturnType<typeof createSupabaseServiceRoleClient>; managerUserId?: string }): Promise<ResidentMoveInResolved | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const db = options?.db ?? createSupabaseServiceRoleClient();
  let applicationQuery = db
    .from("manager_application_records")
    .select("row_data, updated_at, manager_user_id")
    .eq("resident_email", normalizedEmail);
  if (options?.managerUserId) applicationQuery = applicationQuery.eq("manager_user_id", options.managerUserId);
  const { data: records } = await applicationQuery.order("updated_at", { ascending: false });

  const applications = (records ?? [])
    .map((record) => asObject(record.row_data))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => row as unknown as DemoApplicantRow)
    .map((row) => ({ ...row, email: row.email?.trim().toLowerCase() || normalizedEmail }));

  const currentApplications = applications.filter(row => isCurrentResidentApplicationRow(row) && !row.withdrawnAt);
  const homeApplications = currentApplications.length ? currentApplications : applications;
  const bestRow = resolveBestResidentRow(normalizedEmail, homeApplications);
  if (!bestRow) return null;

  const propertyId = propertyIdFromAppRow(bestRow);
  const managerUserId =
    String(
      (records ?? []).find((r) => {
        const row = asObject(r.row_data) as unknown as DemoApplicantRow | null;
        return row && propertyIdFromAppRow(row) === propertyId;
      })?.manager_user_id ?? "",
    ).trim() || null;

  if (!propertyId) {
    return resolveResidentMoveInFromApplications(normalizedEmail, homeApplications, {});
  }

  const { data: propertyRecord } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();

  const roomNames = listingRoomNames(propertyRecord as { property_data?: unknown; row_data?: unknown } | null);
  const property = propertyRecord ? propertyFromRecord(propertyRecord) : undefined;
  const resolved = resolveResidentMoveInFromApplications(normalizedEmail, homeApplications, {
    [propertyId]: property,
  });
  if (!resolved) return null;

  if (!isCurrentResidentApplicationRow(bestRow)) return { ...resolved, housemates: [] };
  const housemates = await loadHousematesForProperty(db, normalizedEmail, propertyId, managerUserId, {
    roomId: canonicalRoomIdFromAppRow(bestRow),
    roomLabel: roomLabelFromAppRow(bestRow, roomNames),
  }, roomNames);
  return { ...resolved, housemates };
}
