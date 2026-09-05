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

function roomLabelFromAppRow(row: DemoApplicantRow): string {
  const manual = row.manualResidentDetails?.roomNumber?.trim() || "";
  const assigned = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  if (manual) return manual;
  if (assigned) {
    const parts = assigned.split("|");
    return parts[parts.length - 1]?.trim() || assigned;
  }
  return "Room TBD";
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
): Promise<ResidentMoveInHousemate[]> {
  if (!propertyId) return [];

  let query = db.from("manager_application_records").select("resident_email, row_data");
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data: apps } = await query;

  const peers: Array<{ email: string; name: string; roomLabel: string; roomId: string }> = [];
  const seen = new Set<string>();
  for (const row of apps ?? []) {
    const rowData = asObject(row.row_data) as unknown as DemoApplicantRow | null;
    if (!rowData || rowData.bucket !== "approved") continue;
    if (propertyIdFromAppRow(rowData) !== propertyId) continue;
    const email = String(row.resident_email ?? rowData.email ?? "")
      .trim()
      .toLowerCase();
    if (!email || email === selfEmail || seen.has(email)) continue;
    seen.add(email);
    peers.push({
      email,
      name: String(rowData.name ?? "").trim() || email,
      roomLabel: roomLabelFromAppRow(rowData),
      roomId: canonicalRoomIdFromAppRow(rowData),
    });
  }

  if (peers.length === 0) return [];

  const { data: profiles } = await db
    .from("profiles")
    .select("email, phone, full_name")
    .in(
      "email",
      peers.map((p) => p.email),
    );

  const phoneByEmail = new Map<string, string | null>();
  const nameByEmail = new Map<string, string>();
  for (const profile of profiles ?? []) {
    const email = String(profile.email ?? "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    phoneByEmail.set(email, formatPhoneDisplay(profile.phone as string | null));
    const fullName = String(profile.full_name ?? "").trim();
    if (fullName) nameByEmail.set(email, fullName);
  }

  return peers
    .map((peer) => ({
      name: nameByEmail.get(peer.email) || peer.name,
      email: peer.email,
      roomLabel: peer.roomLabel,
      phone: phoneByEmail.get(peer.email) ?? null,
      isRoommate: isRoommatePlacement(self, { roomId: peer.roomId, roomLabel: peer.roomLabel }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function loadResidentMoveInForEmail(email: string): Promise<ResidentMoveInResolved | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: records } = await db
    .from("manager_application_records")
    .select("row_data, updated_at, manager_user_id")
    .eq("resident_email", normalizedEmail)
    .order("updated_at", { ascending: false });

  const applications = (records ?? [])
    .map((record) => asObject(record.row_data))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => row as unknown as DemoApplicantRow)
    .map((row) => ({ ...row, email: row.email?.trim().toLowerCase() || normalizedEmail }));

  const bestRow = resolveBestResidentRow(normalizedEmail, applications);
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
    return resolveResidentMoveInFromApplications(normalizedEmail, applications, {});
  }

  const { data: propertyRecord } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();

  const property = propertyRecord ? propertyFromRecord(propertyRecord) : undefined;
  const resolved = resolveResidentMoveInFromApplications(normalizedEmail, applications, {
    [propertyId]: property,
  });
  if (!resolved) return null;

  const housemates = await loadHousematesForProperty(db, normalizedEmail, propertyId, managerUserId, {
    roomId: canonicalRoomIdFromAppRow(bestRow),
    roomLabel: roomLabelFromAppRow(bestRow),
  });
  return { ...resolved, housemates };
}
