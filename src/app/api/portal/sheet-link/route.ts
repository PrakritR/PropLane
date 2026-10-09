import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  ALL_SHEET_PROPERTIES,
  loadGoogleSheetsConnection,
  loadManagerSheetBindings,
  newSheetBindingId,
  occupancyGidForSpreadsheet,
  publicManagerSheetBinding,
  saveGoogleSheetsConnection,
  saveManagerSheetBindings,
  type ManagerSheetBinding,
  type ManagerSheetStaysTab,
  type SheetMode,
  type SheetRefreshMinutes,
} from "@/lib/manager-sheet-link";
import { csvSpreadsheetId, isValidPublishedCsvUrl } from "@/lib/sheet-sync/url";
import { googleSheetsPublicStatus } from "@/lib/sheet-sync/google-sheets-auth";
import { warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import type { StaysTableColumnMap } from "@/lib/sheet-sync/parse-stays-table";

export const runtime = "nodejs";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asMode(value: unknown): SheetMode | null {
  return value === "stays" || value === "occupancy" || value === "raw" ? value : null;
}

/** 15 | 60 | null (manual); undefined when the field was not sent. */
function asRefresh(value: unknown): SheetRefreshMinutes | undefined {
  if (value === null) return null;
  if (value === 15 || value === 60) return value;
  return undefined;
}

export async function GET() {
  const actor = await requireManagerRouteUser({ fast: true });
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  await warmGoogleCalendarOAuthConfig();
  const [bindings, sheets] = await Promise.all([
    loadManagerSheetBindings(actor.db, actor.userId),
    loadGoogleSheetsConnection(actor.db, actor.userId),
  ]);
  return NextResponse.json({
    links: bindings.map(publicManagerSheetBinding),
    sheets: googleSheetsPublicStatus(sheets),
  });
}

export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    spreadsheetId?: unknown;
    title?: unknown;
    workspaceId?: unknown;
    propertyId?: unknown;
    source?: unknown;
    csvUrl?: unknown;
    mode?: unknown;
    refreshMinutes?: unknown;
  } | null;
  const source = body?.source === "csv" ? "csv" : "google";
  const csvUrl = source === "csv" ? asTrimmed(body?.csvUrl) : "";
  if (source === "csv" && !isValidPublishedCsvUrl(csvUrl)) {
    return NextResponse.json(
      { error: "Paste a published CSV link: an https URL ending in .csv, or a Google pub?output=csv link." },
      { status: 400 },
    );
  }
  const spreadsheetId = source === "csv" ? csvSpreadsheetId(csvUrl) : asTrimmed(body?.spreadsheetId);
  if (!spreadsheetId) {
    return NextResponse.json({ error: "Choose a spreadsheet." }, { status: 400 });
  }
  const mode = asMode(body?.mode) ?? "occupancy";
  const refresh = asRefresh(body?.refreshMinutes);
  const refreshMinutes: SheetRefreshMinutes = refresh === undefined ? 15 : refresh;
  const propertyId = asTrimmed(body?.propertyId);
  const next: ManagerSheetBinding = {
    id: newSheetBindingId(),
    title: asTrimmed(body?.title) || "Spreadsheet",
    spreadsheetId,
    occupancyGid: source === "csv" ? "" : occupancyGidForSpreadsheet(spreadsheetId),
    houseTabs: [],
    staysTab: null,
    workspaceId: asTrimmed(body?.workspaceId),
    propertyId: propertyId && propertyId !== ALL_SHEET_PROPERTIES ? propertyId : null,
    autoSync: refreshMinutes != null,
    lastSyncedAt: null,
    lastError: null,
    lastSummary: null,
    source,
    csvUrl: source === "csv" ? csvUrl : null,
    mode,
    refreshMinutes,
    rawHeaders: null,
    rawRows: null,
    rawFetchedAt: null,
  };
  const saved = await saveManagerSheetBindings(actor.db, actor.userId, [
    ...(await loadManagerSheetBindings(actor.db, actor.userId)),
    next,
  ]);
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}

export async function PATCH(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    spreadsheetId?: unknown;
    title?: unknown;
    workspaceId?: unknown;
    propertyId?: unknown;
    autoSync?: unknown;
    mode?: unknown;
    refreshMinutes?: unknown;
    /** BUILD-WAVE2 C210: `null` clears the linked stays tab; omit to leave it as-is. */
    staysTab?: {
      gid?: unknown;
      title?: unknown;
      columnMap?: unknown;
      nameMap?: unknown;
    } | null;
  } | null;
  const id = asTrimmed(body?.id);
  if (!id) return NextResponse.json({ error: "Missing spreadsheet." }, { status: 400 });
  const bindings = await loadManagerSheetBindings(actor.db, actor.userId);
  const index = bindings.findIndex((row) => row.id === id);
  if (index < 0) return NextResponse.json({ error: "Spreadsheet not found." }, { status: 404 });
  const current = bindings[index];
  const spreadsheetId = current.source === "csv" ? current.spreadsheetId : asTrimmed(body?.spreadsheetId) || current.spreadsheetId;
  const propertyRaw = body?.propertyId === null ? ALL_SHEET_PROPERTIES : asTrimmed(body?.propertyId);
  const staysTab: ManagerSheetStaysTab | null =
    body?.staysTab === undefined
      ? current.staysTab
      : body.staysTab === null
        ? null
        : {
            gid: asTrimmed(body.staysTab.gid),
            title: asTrimmed(body.staysTab.title),
            columnMap:
              body.staysTab.columnMap && typeof body.staysTab.columnMap === "object"
                ? (body.staysTab.columnMap as StaysTableColumnMap)
                : null,
            nameMap:
              body.staysTab.nameMap && typeof body.staysTab.nameMap === "object" && !Array.isArray(body.staysTab.nameMap)
                ? Object.fromEntries(
                    Object.entries(body.staysTab.nameMap as Record<string, unknown>).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
                    ),
                  )
                : {},
          };
  if (staysTab && !staysTab.gid) {
    return NextResponse.json({ error: "Choose a tab to link as Stays." }, { status: 400 });
  }
  const nextRefresh = asRefresh(body?.refreshMinutes);
  const refreshMinutes: SheetRefreshMinutes =
    nextRefresh !== undefined
      ? nextRefresh
      : typeof body?.autoSync === "boolean"
        ? body.autoSync
          ? (current.refreshMinutes ?? 15)
          : null
        : current.refreshMinutes;
  bindings[index] = {
    ...current,
    mode: asMode(body?.mode) ?? current.mode,
    refreshMinutes,
    spreadsheetId,
    occupancyGid: occupancyGidForSpreadsheet(spreadsheetId, current.occupancyGid),
    title: asTrimmed(body?.title) || current.title,
    workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId.trim() : current.workspaceId,
    propertyId:
      body?.propertyId === undefined
        ? current.propertyId
        : propertyRaw && propertyRaw !== ALL_SHEET_PROPERTIES
          ? propertyRaw
          : null,
    autoSync: refreshMinutes != null,
    staysTab,
  };
  const saved = await saveManagerSheetBindings(actor.db, actor.userId, bindings);
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}

export async function DELETE(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim() || "";
  const google = url.searchParams.get("google") === "1";
  if (google) {
    await saveGoogleSheetsConnection(actor.db, actor.userId, {
      connected: false,
      email: null,
      refreshToken: null,
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    return NextResponse.json({ ok: true });
  }
  if (!id) return NextResponse.json({ error: "Missing spreadsheet." }, { status: 400 });
  const saved = await saveManagerSheetBindings(
    actor.db,
    actor.userId,
    (await loadManagerSheetBindings(actor.db, actor.userId)).filter((row) => row.id !== id),
  );
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}
