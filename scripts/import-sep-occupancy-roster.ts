/**
 * Import Sep 3–11, 2026 occupancy segments as manager-added residents.
 *
 * Dry run (default):
 *   npx tsx --env-file=.env.local scripts/import-sep-occupancy-roster.ts
 *
 * Apply (dev/test only unless captain explicitly approves production):
 *   ALLOW_IMPORT_TARGET=<project-ref> MANAGER_USER_ID=<uuid> \
 *     npx tsx --env-file=.env.local scripts/import-sep-occupancy-roster.ts --write
 *
 * Does NOT send email/SMS. Airbnb rows get rentalType `airbnb` (no PropLane charges).
 * Does NOT edit manager_property_records — enable Airbnb on each listing in the portal first.
 */
import { createClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { AIRBNB_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import {
  SEP_2026_OCCUPANCY_SEGMENTS,
  occupancyImportAxisId,
  type OccupancySegment,
} from "@/lib/sep-occupancy-roster-2026";

const write = process.argv.includes("--write");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const managerUserId = process.env.MANAGER_USER_ID?.trim() ?? "";

function targetFromUrl(raw: string): string {
  try {
    const host = new URL(raw).host;
    const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
    return hosted ? hosted[1]! : host;
  } catch {
    return "";
  }
}

function slugEmail(name: string, propertyId: string, roomNumber: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/^airbnb\s+/i, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 32);
  const prop = propertyId.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase();
  return `occupancy.${slug || "guest"}.r${roomNumber}.${prop}@import.proplane.local`;
}

type ListingRoom = { id: string; name: string };

function roomIdForNumber(rooms: ListingRoom[], roomNumber: number): string | null {
  const target = `room ${roomNumber}`.replace(/\s+/g, " ").toLowerCase();
  const hit = rooms.find((r) => r.name.trim().toLowerCase().replace(/\s+/g, " ") === target);
  if (hit) return hit.id;
  const byNum = rooms.find((r) => {
    const m = /^room\s*(\d+)$/i.exec(r.name.trim());
    return m && Number(m[1]) === roomNumber;
  });
  return byNum?.id ?? null;
}

function buildRow(
  segment: OccupancySegment,
  propertyLabel: string,
  roomChoice: string,
  roomLabel: string,
  managerId: string,
): DemoApplicantRow {
  const isAirbnb = segment.leaseTerm === "airbnb";
  const email = slugEmail(segment.name, segment.propertyId, segment.roomNumber);
  const id = occupancyImportAxisId(segment.propertyId, segment.roomNumber, segment.moveIn, segment.name);
  return {
    id,
    name: segment.name.trim(),
    email,
    property: propertyLabel,
    stage: "Active",
    bucket: "approved",
    detail: "Imported from Sep 2026 occupancy grid",
    assignedPropertyId: segment.propertyId,
    assignedRoomChoice: roomChoice,
    managerUserId: managerId,
    manuallyAdded: true,
    manualResidentDetails: {
      moveInDate: segment.moveIn,
      moveOutDate: segment.moveOut,
      roomNumber: roomLabel,
      leaseTerm: isAirbnb ? "airbnb" : "long_term",
      notes: "Sep 2026 occupancy import",
    },
    application: {
      propertyId: segment.propertyId,
      roomChoice1: roomChoice,
      leaseTerm: isAirbnb ? AIRBNB_LEASE_TERM : "12-Month",
      rentalType: isAirbnb ? "airbnb" : "standard",
      leaseStart: segment.moveIn,
      leaseEnd: segment.moveOut,
      fullLegalName: segment.name.trim(),
      email,
    },
  };
}

async function main() {
  const target = targetFromUrl(url);
  const segments = SEP_2026_OCCUPANCY_SEGMENTS;
  console.log(`Target: ${target || "(unparseable)"}`);
  console.log(`Segments: ${segments.length} (${segments.filter((s) => s.leaseTerm === "airbnb").length} Airbnb)`);

  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const propertyIds = [...new Set(segments.map((s) => s.propertyId))];

  const { data: propertyRows, error: propErr } = await db
    .from("manager_property_records")
    .select("id, property_data, manager_user_id")
    .in("id", propertyIds);
  if (propErr) throw new Error(propErr.message);

  const propertyById = new Map(
    (propertyRows ?? []).map((row) => {
      const submission = row.property_data?.listingSubmission;
      const rooms: ListingRoom[] = Array.isArray(submission?.rooms)
        ? submission.rooms.map((r: { id?: string; name?: string }) => ({
            id: String(r.id ?? ""),
            name: String(r.name ?? ""),
          }))
        : [];
      const label =
        row.property_data?.buildingName?.trim() ||
        submission?.propertyName?.trim() ||
        row.id;
      return [row.id, { label, rooms, managerUserId: row.manager_user_id as string | null }];
    }),
  );

  const rows: DemoApplicantRow[] = [];
  const warnings: string[] = [];

  for (const segment of segments) {
    const prop = propertyById.get(segment.propertyId);
    if (!prop) {
      warnings.push(`Missing property ${segment.propertyId} (${segment.name})`);
      continue;
    }
    const roomId = roomIdForNumber(prop.rooms, segment.roomNumber);
    if (!roomId) {
      warnings.push(`No room ${segment.roomNumber} on ${segment.propertyId} (${segment.name})`);
      continue;
    }
    const roomChoice = `${segment.propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
    const roomLabel = prop.rooms.find((r) => r.id === roomId)?.name ?? `Room ${segment.roomNumber}`;
    const mgr = managerUserId || prop.managerUserId || "";
    if (!mgr) {
      warnings.push(`No manager id for ${segment.propertyId}`);
      continue;
    }
    rows.push(buildRow(segment, prop.label, roomChoice, roomLabel, mgr));
  }

  console.log(`Planned resident rows: ${rows.length}`);
  for (const w of warnings) console.log(`  WARN: ${w}`);

  if (!write) {
    console.log("\nDRY RUN — pass --write to upsert manager_application_records.");
    for (const row of rows.slice(0, 5)) {
      console.log(`  ${row.id} ${row.name} ${row.assignedPropertyId} ${row.application?.leaseStart}→${row.application?.leaseEnd}`);
    }
    if (rows.length > 5) console.log(`  … and ${rows.length - 5} more`);
    return;
  }

  const allowed = process.env.ALLOW_IMPORT_TARGET?.trim() ?? "";
  if (!target || allowed !== target) {
    console.error(
      `\nRefusing to write: set ALLOW_IMPORT_TARGET=${target || "<project-ref>"} after confirming environment.`,
    );
    process.exit(2);
  }

  const effectiveManagerId = managerUserId || rows[0]?.managerUserId;
  if (!effectiveManagerId) {
    console.error("MANAGER_USER_ID required for --write");
    process.exit(2);
  }

  let written = 0;
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const values = {
      id: row.id,
      manager_user_id: row.managerUserId || effectiveManagerId,
      resident_email: row.email.trim().toLowerCase(),
      property_id: row.assignedPropertyId || null,
      assigned_property_id: row.assignedPropertyId || null,
      row_data: row,
      updated_at: nowIso,
    };
    const { error } = await db.from("manager_application_records").upsert(values, { onConflict: "id" });
    if (error) {
      warnings.push(`Write failed ${row.id}: ${error.message}`);
      continue;
    }
    written += 1;
  }

  console.log(`\nWrote ${written} of ${rows.length} application rows.`);
  if (warnings.length) {
    for (const w of warnings) console.log(`  ${w}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
