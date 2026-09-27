import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadManagerSheetBindings } from "@/lib/manager-sheet-link";
import { detectSheetLayout } from "@/lib/sheet-sync/detect-layout";
import { listSheetsApiTabs, fetchStaysTabRows } from "@/lib/sheet-sync/fetch-sheet";
import { getGoogleSheetsAccessToken } from "@/lib/sheet-sync/google-sheets-auth";
import { detectStaysTableColumns, parseStaysTable } from "@/lib/sheet-sync/parse-stays-table";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { resolveSheetPropertyId } from "@/lib/sheet-sync/match";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export const runtime = "nodejs";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads and parses a picked spreadsheet without saving anything
 * (BUILD-WAVE2 C210's Build tab: "Reads and parses without saving. Returns
 * counts, detected columns and unmatched names."). Two modes:
 *  - `{ spreadsheetId }` alone lists every tab so the manager can pick which
 *    one is the Stays tab.
 *  - `{ spreadsheetId, gid, title }` reads that one tab and previews it —
 *    layout, detected columns, row/house/room counts, and any house name it
 *    could not match to a listing.
 */
export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    spreadsheetId?: unknown;
    gid?: unknown;
    title?: unknown;
  } | null;
  const spreadsheetId = asTrimmed(body?.spreadsheetId);
  if (!spreadsheetId) return NextResponse.json({ error: "Pick a spreadsheet first." }, { status: 400 });

  const accessToken = await getGoogleSheetsAccessToken(actor.db, actor.userId);
  if (!accessToken) return NextResponse.json({ error: "Connect Google Sheets first." }, { status: 401 });

  const gid = asTrimmed(body?.gid);
  if (!gid) {
    const tabs = await listSheetsApiTabs(spreadsheetId, accessToken);
    return NextResponse.json({ tabs: tabs.map((tab) => ({ gid: tab.gid, title: tab.title })) });
  }

  const title = asTrimmed(body?.title);
  const rows = await fetchStaysTabRows(spreadsheetId, { gid, title }, accessToken);
  if (!rows) {
    return NextResponse.json({ error: "Pick the sheet again." }, { status: 400 });
  }

  const layout = detectSheetLayout(rows, pacificTodayKey());
  const headerRow = rows[0] ?? [];
  const columnMap = detectStaysTableColumns(headerRow);
  const { stays, skipped } = parseStaysTable(rows, pacificTodayKey());

  // Which house names the parser found could not be matched to a listing —
  // the "a name to match" screen in the plan.
  const bindings = await loadManagerSheetBindings(actor.db, actor.userId);
  const currentNameMap = bindings.find((row) => row.spreadsheetId === spreadsheetId && row.staysTab)?.staysTab?.nameMap ?? {};
  const { data: propertyRows } = await actor.db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", actor.userId);
  const properties = (propertyRows ?? []).map((row) => {
    const rowData = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
    const propertyData = (row.property_data && typeof row.property_data === "object" ? row.property_data : {}) as Record<
      string,
      unknown
    >;
    const raw = propertyData.listingSubmission ?? rowData.submission;
    const submission =
      raw && typeof raw === "object" ? normalizeManagerListingSubmissionV1(raw as Parameters<typeof normalizeManagerListingSubmissionV1>[0]) : null;
    return { id: String(row.id), address: submission?.address ?? "", title: submission?.buildingName ?? "", buildingName: submission?.buildingName ?? "" };
  });

  const { data: profile } = await actor.db.from("profiles").select("email").eq("id", actor.userId).maybeSingle();
  const managerEmail = (profile?.email as string | undefined) ?? null;

  const houseGroups = new Map<string, { houseKey: string; houseRaw: string; count: number; matched: boolean }>();
  for (const stay of stays) {
    const key = stay.houseKey;
    const existing = houseGroups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const matched =
      Boolean(currentNameMap[stay.houseRaw]) ||
      Boolean(resolveSheetPropertyId(key, properties, { managerEmail, spreadsheetId }));
    houseGroups.set(key, { houseKey: key, houseRaw: stay.houseRaw, count: 1, matched });
  }
  const unmatchedHouses = [...houseGroups.values()].filter((group) => !group.matched);

  const roomKeys = new Set(stays.map((stay) => `${stay.houseKey}::${stay.roomNumber ?? "whole-home"}`));
  const channelCounts = stays.reduce<Record<string, number>>((acc, stay) => {
    acc[stay.channel] = (acc[stay.channel] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    layout,
    columnMap,
    stayCount: stays.length,
    houseCount: houseGroups.size,
    roomCount: roomKeys.size,
    skipped,
    channelCounts,
    unmatchedHouses: unmatchedHouses.map((group) => ({ houseRaw: group.houseRaw, count: group.count })),
    readyToLink: stays.length > 0 && unmatchedHouses.length === 0,
  });
}
