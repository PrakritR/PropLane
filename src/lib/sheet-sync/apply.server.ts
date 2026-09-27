import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { roomIdForNumber } from "@/lib/ambika-seattle-occupancy";
import { IMPORTED_AIRBNB_REASON, IMPORTED_BOOKING_REASON } from "@/lib/channel-calendar/property-bookings";
import { exclusiveCheckoutAfterLastNight, pacificTodayKey } from "@/lib/sheet-sync/dates";
import { namesOverlap } from "@/lib/sheet-sync/house-key";
import { assertWritableSheetPropertyId, filterSheetPropertyMap, resolveSheetPropertyId } from "@/lib/sheet-sync/match";
import { normalizeHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  occupancyGidForSpreadsheet,
  loadManagerSheetBindings,
  saveManagerSheetBindings,
  sheetBindingAppliesToProperty,
  type ManagerSheetBinding,
} from "@/lib/manager-sheet-link";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import { accessNotes, parseHouseTab, type HouseRoomFact, type ParsedHouseTab } from "@/lib/sheet-sync/parse-house-tab";
import { parseOccupancyGrid, type OccupancyStay } from "@/lib/sheet-sync/parse-occupancy";
import { parseStaysTable, type StaysTableStay } from "@/lib/sheet-sync/parse-stays-table";
import { fetchStaysTabRows, loadWorkbookTabs } from "@/lib/sheet-sync/fetch-sheet";
import { getGoogleSheetsAccessToken } from "@/lib/sheet-sync/google-sheets-auth";
import { loadWorkspaces } from "@/lib/workspaces/server";

export const SHEET_SYNC_FLAG = "sheetSync";

export type SheetSyncSummary = {
  bookingsUpserted: number;
  bookingsRemoved: number;
  bookingsClosed: number;
  houseDetailsUpdated: number;
  paymentsUpdated: number;
  warnings: string[];
};

function emptySummary(): SheetSyncSummary {
  return {
    bookingsUpserted: 0,
    bookingsRemoved: 0,
    bookingsClosed: 0,
    houseDetailsUpdated: 0,
    paymentsUpdated: 0,
    warnings: [],
  };
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function listingFromPropertyRow(row: { row_data?: unknown; property_data?: unknown }) {
  const propertyData = asObject(row.property_data);
  const rowData = asObject(row.row_data);
  const raw = propertyData.listingSubmission ?? rowData.submission;
  if (!raw || typeof raw !== "object") return null;
  return normalizeManagerListingSubmissionV1(raw as Parameters<typeof normalizeManagerListingSubmissionV1>[0]);
}

function staySlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "guest"
  );
}

function channelReason(channel: OccupancyStay["channel"]): string {
  return channel === "Booking" ? IMPORTED_BOOKING_REASON : IMPORTED_AIRBNB_REASON;
}

function isChannelStay(stay: OccupancyStay): boolean {
  return stay.channel === "Airbnb" || stay.channel === "Booking";
}

function isImportedChannelReason(reason: string): boolean {
  const value = reason.trim().toLowerCase();
  return value === IMPORTED_AIRBNB_REASON.toLowerCase() || value === IMPORTED_BOOKING_REASON.toLowerCase();
}

type PropertyRow = {
  id: string;
  row_data: unknown;
  property_data: unknown;
};

async function loadOwnedProperties(db: SupabaseClient, managerUserId: string): Promise<PropertyRow[]> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", managerUserId);
  if (error) throw error;
  return (data ?? []) as PropertyRow[];
}

function propertyMeta(row: PropertyRow) {
  const sub = listingFromPropertyRow(row);
  return {
    id: row.id,
    address: sub?.address ?? "",
    title: sub?.buildingName ?? "",
    buildingName: sub?.buildingName ?? "",
    rooms: sub?.rooms ?? [],
    submission: sub,
    row,
  };
}

async function applyBookings(
  db: SupabaseClient,
  managerUserId: string,
  stays: OccupancyStay[],
  propertyByHouse: Map<string, ReturnType<typeof propertyMeta>>,
  summary: SheetSyncSummary,
): Promise<void> {
  const today = pacificTodayKey();
  const wanted = new Map<
    string,
    {
      id: string;
      propertyId: string;
      roomId: string;
      checkIn: string;
      checkOut: string;
      reason: string;
      residentName: string;
    }
  >();

  for (const stay of stays.filter(isChannelStay)) {
    const property = propertyByHouse.get(stay.houseKey);
    if (!property) {
      summary.warnings.push(`No listing matched ${stay.houseKey} for ${stay.name}.`);
      continue;
    }
    const locked = assertWritableSheetPropertyId(property.id);
    if (locked) {
      summary.warnings.push(locked);
      continue;
    }
    const roomId = roomIdForNumber(property.rooms, stay.roomNumber);
    if (!roomId) {
      summary.warnings.push(`${stay.houseKey} has no Room ${stay.roomNumber} for ${stay.name}.`);
      continue;
    }
    const uid = `sheet_${property.id}_${roomId}_${stay.start}_${staySlug(stay.name)}_${stay.channel!.toLowerCase()}`;
    const id = roomDateBlockRecordId(managerUserId, uid);
    wanted.set(id, {
      id,
      propertyId: property.id,
      roomId,
      checkIn: stay.start,
      checkOut: exclusiveCheckoutAfterLastNight(stay.end),
      reason: channelReason(stay.channel),
      residentName: stay.name,
    });
  }

  const mappedPropertyIds = [...new Set([...propertyByHouse.values()].map((p) => p.id))];
  if (mappedPropertyIds.length === 0) return;

  const { data: existing, error } = await db
    .from("portal_schedule_records")
    .select("id, property_id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .in("property_id", mappedPropertyIds);
  if (error) throw error;

  const now = new Date().toISOString();
  const existingIds = new Set<string>();
  for (const row of existing ?? []) {
    const id = String(row.id);
    existingIds.add(id);
    const rowData = asObject(row.row_data);
    const sheetOwned = rowData[SHEET_SYNC_FLAG] === true || id.includes("_sheet_");
    if (sheetOwned && !wanted.has(id)) {
      const { error: delError } = await db
        .from("portal_schedule_records")
        .delete()
        .eq("id", id)
        .eq("manager_user_id", managerUserId);
      if (delError) summary.warnings.push(delError.message);
      else summary.bookingsRemoved += 1;
      continue;
    }
    if (
      !sheetOwned &&
      isImportedChannelReason(String(rowData.reason ?? "")) &&
      String(rowData.checkOut ?? "") > today
    ) {
      const name = String(rowData.residentName ?? "");
      const roomId = String(rowData.roomId ?? "");
      const stillPresent = [...wanted.values()].some(
        (stay) => stay.roomId === roomId && namesOverlap(stay.residentName, name),
      );
      if (!stillPresent) {
        const closed = exclusiveCheckoutAfterLastNight(today);
        const { error: closeError } = await db
          .from("portal_schedule_records")
          .update({
            row_data: { ...rowData, checkOut: closed, endsAt: `${closed}T00:00:00` },
            updated_at: now,
          })
          .eq("id", id)
          .eq("manager_user_id", managerUserId);
        if (closeError) summary.warnings.push(closeError.message);
        else summary.bookingsClosed += 1;
      }
    }
  }

  for (const booking of wanted.values()) {
    const createdAt = now;
    const rowData = {
      id: booking.id,
      recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
      propertyId: booking.propertyId,
      roomId: booking.roomId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      reason: booking.reason,
      residentName: booking.residentName,
      [SHEET_SYNC_FLAG]: true,
      createdAt,
      startsAt: `${booking.checkIn}T00:00:00`,
      endsAt: `${booking.checkOut}T00:00:00`,
    };
    const { error: upsertError } = await db.from("portal_schedule_records").upsert(
      {
        id: booking.id,
        manager_user_id: managerUserId,
        property_id: booking.propertyId,
        record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
        row_data: rowData,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (upsertError) summary.warnings.push(`${booking.residentName}: ${upsertError.message}`);
    else if (!existingIds.has(booking.id)) summary.bookingsUpserted += 1;
    else summary.bookingsUpserted += 1;
  }
}

/**
 * Stays-table rows (BUILD-WAVE2 C210/C213) go through the same duplicate-safe
 * upsert/remove contract as {@link applyBookings}, on a distinct `sheet_stays_`
 * id namespace so the two importers never collide or fight over the same
 * record. Every source imports (Airbnb, Booking, Tenant, Direct, Other —
 * captain decision C213: "import every row, with Tenant as the channel"),
 * unlike the grid importer, which only ever produced Airbnb/Booking. Airbnb
 * and Booking rows reuse the exact same `reason` the grid importer writes, so
 * they draw identically (`source: "airbnb"` / `"booking_com"`); every other
 * channel is stored as a plain hold with the guest's name attached — the
 * existing room-date-block renderer already colours a named hold distinctly
 * (`bookingVisualSource`), so this needed no change to the display-source
 * enum to show up correctly on Bookings.
 */
async function applyStaysTableBookings(
  db: SupabaseClient,
  managerUserId: string,
  stays: StaysTableStay[],
  propertyByHouse: Map<string, ReturnType<typeof propertyMeta>>,
  properties: ReturnType<typeof propertyMeta>[],
  nameMap: Record<string, string>,
  summary: SheetSyncSummary,
): Promise<void> {
  const wanted = new Map<
    string,
    {
      id: string;
      propertyId: string;
      roomId: string;
      checkIn: string;
      checkOut: string;
      reason: string;
      residentName: string | null;
      notes: string;
    }
  >();

  for (const stay of stays) {
    // A manager's own remembered match (from the preview screen, C210) wins
    // over automatic house-key matching — it exists precisely for the sheet
    // spellings the matcher could not resolve on its own.
    const overrideId = nameMap[stay.houseRaw];
    const property = overrideId ? properties.find((p) => p.id === overrideId) : propertyByHouse.get(stay.houseKey);
    if (!property) {
      summary.warnings.push(`No listing matched ${stay.houseRaw || stay.houseKey} for ${stay.name}.`);
      continue;
    }
    const locked = assertWritableSheetPropertyId(property.id);
    if (locked) {
      summary.warnings.push(locked);
      continue;
    }
    if (!stay.end) {
      // Open-ended stays-table rows are read (parse-stays-table.ts keeps
      // them), but a room-date block always needs a real checkout — rather
      // than guess a far-future date and risk blocking a room nobody meant to
      // hold that long, this one row is skipped with a clear reason so the
      // manager can add an end date (or use "Update from sheet" once they do).
      summary.warnings.push(`${stay.name} at ${property.address || stay.houseRaw} has no check-out date — add one to import this stay.`);
      continue;
    }
    let roomId = "";
    if (stay.roomNumber != null) {
      const resolved = roomIdForNumber(property.rooms, stay.roomNumber);
      if (!resolved) {
        summary.warnings.push(`${property.address || stay.houseKey} has no Room ${stay.roomNumber} for ${stay.name}.`);
        continue;
      }
      roomId = resolved;
    }
    const isChannelImport = stay.channel === "Airbnb" || stay.channel === "Booking";
    const uid = `sheet_stays_${property.id}_${roomId}_${stay.start}_${staySlug(stay.name)}_${stay.channel.toLowerCase()}`;
    const id = roomDateBlockRecordId(managerUserId, uid);
    wanted.set(id, {
      id,
      propertyId: property.id,
      roomId,
      checkIn: stay.start,
      checkOut: exclusiveCheckoutAfterLastNight(stay.end),
      reason: isChannelImport ? channelReason(stay.channel === "Booking" ? "Booking" : "Airbnb") : stay.channel,
      residentName: isChannelImport ? null : stay.name,
      notes: stay.notes,
    });
  }

  const mappedPropertyIds = [...new Set([...propertyByHouse.values()].map((p) => p.id))];
  if (mappedPropertyIds.length === 0) return;

  const { data: existing, error } = await db
    .from("portal_schedule_records")
    .select("id, property_id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .in("property_id", mappedPropertyIds);
  if (error) throw error;

  const now = new Date().toISOString();
  const existingIds = new Set<string>();
  for (const row of existing ?? []) {
    const id = String(row.id);
    existingIds.add(id);
    const rowData = asObject(row.row_data);
    const staysOwned = rowData[SHEET_SYNC_FLAG] === true && id.includes("_stays_");
    if (staysOwned && !wanted.has(id)) {
      const { error: delError } = await db
        .from("portal_schedule_records")
        .delete()
        .eq("id", id)
        .eq("manager_user_id", managerUserId);
      if (delError) summary.warnings.push(delError.message);
      else summary.bookingsRemoved += 1;
    }
  }

  for (const booking of wanted.values()) {
    const rowData: Record<string, unknown> = {
      id: booking.id,
      recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
      propertyId: booking.propertyId,
      roomId: booking.roomId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      reason: booking.reason,
      [SHEET_SYNC_FLAG]: true,
      createdAt: now,
      startsAt: `${booking.checkIn}T00:00:00`,
      endsAt: `${booking.checkOut}T00:00:00`,
      ...(booking.residentName ? { residentName: booking.residentName } : {}),
      ...(booking.notes ? { sheetNotes: booking.notes } : {}),
    };
    const { error: upsertError } = await db.from("portal_schedule_records").upsert(
      {
        id: booking.id,
        manager_user_id: managerUserId,
        property_id: booking.propertyId,
        record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
        row_data: rowData,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (upsertError) summary.warnings.push(`${booking.residentName ?? "stay"}: ${upsertError.message}`);
    else summary.bookingsUpserted += 1;
  }
}

async function applyHouseDetails(
  db: SupabaseClient,
  managerUserId: string,
  tabs: ParsedHouseTab[],
  propertyByHouse: Map<string, ReturnType<typeof propertyMeta>>,
  summary: SheetSyncSummary,
): Promise<void> {
  for (const tab of tabs) {
    if (!tab.houseKey) continue;
    const property = propertyByHouse.get(tab.houseKey);
    if (!property?.submission) continue;
    const locked = assertWritableSheetPropertyId(property.id);
    if (locked) {
      summary.warnings.push(locked);
      continue;
    }
    const notes = accessNotes(tab.access, tab.rooms);
    if (!tab.access.doorCode && !tab.access.gateCode && !tab.access.lockboxCode && !notes) continue;
    let houseInfo = normalizeHouseInfo(property.submission.houseInfo);
    if (tab.access.doorCode) houseInfo = setHouseInfoValue(houseInfo, "access", "doorCode", tab.access.doorCode);
    if (tab.access.gateCode) houseInfo = setHouseInfoValue(houseInfo, "access", "gateCode", tab.access.gateCode);
    if (tab.access.lockboxCode) houseInfo = setHouseInfoValue(houseInfo, "access", "keyPickup", tab.access.lockboxCode);
    if (notes) houseInfo = setHouseInfoValue(houseInfo, "access", "notes", notes);
    const nextSubmission = { ...property.submission, houseInfo };
    const rowData = asObject(property.row.row_data);
    const propertyData = asObject(property.row.property_data);
    const nextPropertyData = propertyData.listingSubmission
      ? { ...propertyData, listingSubmission: nextSubmission }
      : propertyData;
    const nextRowData = rowData.submission ? { ...rowData, submission: nextSubmission } : rowData;
    const { error } = await db
      .from("manager_property_records")
      .update({ row_data: nextRowData, property_data: nextPropertyData, updated_at: new Date().toISOString() })
      .eq("id", property.id)
      .eq("manager_user_id", managerUserId);
    if (error) summary.warnings.push(`${tab.houseKey} house details: ${error.message}`);
    else summary.houseDetailsUpdated += 1;
  }
}

async function applyPayments(
  db: SupabaseClient,
  managerUserId: string,
  rooms: HouseRoomFact[],
  propertyByHouse: Map<string, ReturnType<typeof propertyMeta>>,
  summary: SheetSyncSummary,
): Promise<void> {
  const payable = rooms.filter((room) => !room.airbnbPlaceholder && room.name && room.rentDollars && room.rentDollars > 0);
  if (payable.length === 0) return;
  const { data, error } = await db
    .from("portal_recurring_rent_profile_records")
    .select("id, property_id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("active", true);
  if (error) throw error;

  for (const fact of payable) {
    const property = propertyByHouse.get(fact.houseKey);
    if (!property) continue;
    const locked = assertWritableSheetPropertyId(property.id);
    if (locked) continue;
    const match = (data ?? []).find((row) => {
      if (String(row.property_id) !== property.id) return false;
      const profile = asObject(row.row_data);
      return namesOverlap(String(profile.residentName ?? ""), fact.name);
    });
    if (!match) continue;
    const profile = asObject(match.row_data);
    const next = {
      ...profile,
      monthlyRent: fact.rentDollars,
      ...(fact.utilitiesDollars != null ? { monthlyUtilities: fact.utilitiesDollars } : {}),
      updatedAt: new Date().toISOString(),
    };
    const rentChanged = Number(profile.monthlyRent) !== fact.rentDollars;
    const utilChanged =
      fact.utilitiesDollars != null && Number(profile.monthlyUtilities ?? 0) !== fact.utilitiesDollars;
    if (!rentChanged && !utilChanged) continue;
    const { error: updateError } = await db
      .from("portal_recurring_rent_profile_records")
      .update({ row_data: next, updated_at: new Date().toISOString() })
      .eq("id", match.id)
      .eq("manager_user_id", managerUserId);
    if (updateError) summary.warnings.push(`${fact.name} rent: ${updateError.message}`);
    else summary.paymentsUpdated += 1;
  }
}

function summarizeLine(summary: SheetSyncSummary): string {
  return [
    `${summary.bookingsUpserted} bookings`,
    summary.bookingsRemoved ? `${summary.bookingsRemoved} removed` : null,
    summary.bookingsClosed ? `${summary.bookingsClosed} closed` : null,
    `${summary.houseDetailsUpdated} houses`,
    `${summary.paymentsUpdated} rents`,
  ]
    .filter(Boolean)
    .join(" · ");
}

async function allowedPropertyIdsForBinding(
  db: SupabaseClient,
  managerUserId: string,
  link: ManagerSheetBinding,
): Promise<Set<string> | null> {
  if (link.propertyId) return new Set([link.propertyId]);
  if (!link.workspaceId) return null;
  const workspaces = await loadWorkspaces(db, managerUserId);
  const workspace = workspaces.find((row) => row.id === link.workspaceId);
  return new Set(workspace?.propertyIds ?? []);
}

async function syncOneBinding(
  db: SupabaseClient,
  managerUserId: string,
  link: ManagerSheetBinding,
  opts?: { managerEmail?: string | null },
): Promise<{ ok: boolean; summary: SheetSyncSummary; error: string | null; link: ManagerSheetBinding }> {
  const summary = emptySummary();
  const occupancyGid = occupancyGidForSpreadsheet(link.spreadsheetId, link.occupancyGid);
  const accessToken = await getGoogleSheetsAccessToken(db, managerUserId);
  const workbook = await loadWorkbookTabs({
    spreadsheetId: link.spreadsheetId,
    occupancyGid,
    houseTabs: link.houseTabs,
    accessToken,
  });
  if (workbook.error && !workbook.occupancy && workbook.houses.length === 0) {
    return { ok: false, summary, error: workbook.error, link: { ...link, lastError: workbook.error, lastSummary: null } };
  }

  const asOf = pacificTodayKey();
  const stays = workbook.occupancy ? parseOccupancyGrid(workbook.occupancy.rows, asOf) : [];
  const houseTabs = workbook.houses.map((tab) => parseHouseTab(tab.rows, tab.title, asOf));
  const roomFacts = houseTabs.flatMap((tab) => tab.rooms);

  // A manager-picked stays tab (BUILD-WAVE2 C210) — a one-row-per-stay
  // reader, entirely separate from the day-by-day occupancy grid above.
  let staysTableStays: import("@/lib/sheet-sync/parse-stays-table").StaysTableStay[] = [];
  if (link.staysTab) {
    const staysRows = await fetchStaysTabRows(link.spreadsheetId, link.staysTab, accessToken);
    if (staysRows) {
      staysTableStays = parseStaysTable(staysRows, asOf, link.staysTab.columnMap ?? undefined).stays;
    } else {
      summary.warnings.push("Could not read the linked Stays tab — pick the sheet again.");
    }
  }

  const properties = (await loadOwnedProperties(db, managerUserId)).map(propertyMeta);
  let propertyByHouse = new Map<string, ReturnType<typeof propertyMeta>>();
  const houseKeys = new Set<string>([
    ...stays.map((stay) => stay.houseKey),
    ...houseTabs.map((tab) => tab.houseKey).filter((key): key is string => Boolean(key)),
    ...staysTableStays.map((stay) => stay.houseKey),
  ]);
  for (const houseKey of houseKeys) {
    const id = resolveSheetPropertyId(houseKey, properties, {
      managerEmail: opts?.managerEmail,
      spreadsheetId: link.spreadsheetId,
    });
    if (!id) {
      summary.warnings.push(`No listing matched house ${houseKey}.`);
      continue;
    }
    const locked = assertWritableSheetPropertyId(id);
    if (locked) {
      summary.warnings.push(locked);
      continue;
    }
    const property = properties.find((row) => row.id === id);
    if (property) propertyByHouse.set(houseKey, property);
  }
  propertyByHouse = filterSheetPropertyMap(propertyByHouse, await allowedPropertyIdsForBinding(db, managerUserId, link));

  await applyBookings(db, managerUserId, stays, propertyByHouse, summary);
  await applyHouseDetails(db, managerUserId, houseTabs, propertyByHouse, summary);
  await applyPayments(db, managerUserId, roomFacts, propertyByHouse, summary);
  if (link.staysTab) {
    await applyStaysTableBookings(
      db,
      managerUserId,
      staysTableStays,
      propertyByHouse,
      properties,
      link.staysTab.nameMap,
      summary,
    );
  }

  return {
    ok: true,
    summary,
    error: null,
    link: {
      ...link,
      occupancyGid,
      lastSyncedAt: new Date().toISOString(),
      lastError: summary.warnings[0] ?? null,
      lastSummary: summarizeLine(summary),
    },
  };
}

export async function syncManagerLinkedSheet(
  db: SupabaseClient,
  managerUserId: string,
  opts?: { managerEmail?: string | null; linkId?: string | null; propertyId?: string | null },
): Promise<{ ok: boolean; summary: SheetSyncSummary; error: string | null }> {
  const bindings = await loadManagerSheetBindings(db, managerUserId);
  if (bindings.length === 0) {
    return { ok: false, summary: emptySummary(), error: "Add a spreadsheet in Settings first." };
  }

  const workspaces = await loadWorkspaces(db, managerUserId);
  const selected = bindings.filter((link) => {
    if (opts?.linkId && link.id !== opts.linkId) return false;
    if (opts?.propertyId) {
      const workspace = workspaces.find((row) => row.id === link.workspaceId);
      return sheetBindingAppliesToProperty(link, opts.propertyId, workspace?.propertyIds);
    }
    return true;
  });
  if (selected.length === 0) {
    return { ok: false, summary: emptySummary(), error: "No spreadsheet applies to this house." };
  }

  const combined = emptySummary();
  let firstError: string | null = null;
  const nextBindings = bindings.map((row) => ({ ...row }));
  for (const link of selected) {
    const result = await syncOneBinding(db, managerUserId, link, opts);
    const index = nextBindings.findIndex((row) => row.id === link.id);
    if (index >= 0) nextBindings[index] = result.link;
    combined.bookingsUpserted += result.summary.bookingsUpserted;
    combined.bookingsRemoved += result.summary.bookingsRemoved;
    combined.bookingsClosed += result.summary.bookingsClosed;
    combined.houseDetailsUpdated += result.summary.houseDetailsUpdated;
    combined.paymentsUpdated += result.summary.paymentsUpdated;
    combined.warnings.push(...result.summary.warnings);
    if (!result.ok && !firstError) firstError = result.error;
  }
  await saveManagerSheetBindings(db, managerUserId, nextBindings);
  if (firstError) return { ok: false, summary: combined, error: firstError };
  return { ok: true, summary: combined, error: null };
}
